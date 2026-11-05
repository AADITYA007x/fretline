package com.fretline.app;

import android.graphics.Bitmap;
import android.graphics.Color;
import android.graphics.Rect;
import android.media.Image;
import android.media.MediaCodec;
import android.media.MediaCodecInfo;
import android.media.MediaExtractor;
import android.media.MediaFormat;
import android.media.MediaMetadataRetriever;
import android.os.Build;
import android.util.Base64;
import android.util.Log;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.android.gms.tasks.Tasks;
import com.google.mlkit.vision.common.InputImage;
import com.google.mlkit.vision.text.Text;
import com.google.mlkit.vision.text.TextRecognition;
import com.google.mlkit.vision.text.TextRecognizer;
import com.google.mlkit.vision.text.latin.TextRecognizerOptions;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.ByteBuffer;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONArray;
import org.json.JSONObject;
import org.schabi.newpipe.extractor.NewPipe;
import org.schabi.newpipe.extractor.ServiceList;
import org.schabi.newpipe.extractor.localization.ContentCountry;
import org.schabi.newpipe.extractor.localization.Localization;
import org.schabi.newpipe.extractor.services.youtube.ItagItem;
import org.schabi.newpipe.extractor.services.youtube.YoutubeParsingHelper;
import org.schabi.newpipe.extractor.stream.DeliveryMethod;
import org.schabi.newpipe.extractor.stream.StreamInfo;
import org.schabi.newpipe.extractor.stream.AudioStream;
import org.schabi.newpipe.extractor.stream.VideoStream;

/**
 * Reading the tab shown in a lesson video. The video is downloaded once
 * (picture only) into the app's private cache, looked at, and deleted.
 *
 * The app's TypeScript does the thinking (where the tab is, when pages
 * change, where the cursor is); this side does the heavy lifting:
 *  - prepare/download: pick a video-only stream (up to 720p) and fetch it
 *  - overview: a few frames as small grey pictures, to find the tab
 *  - features: decode the whole video once and, a few times a second,
 *    measure the tab area (brightness and blue/yellow per column, plus a
 *    tiny picture to spot page changes)
 *  - areas + read: the tab area at chosen moments (the app finds the digits
 *    and lays them out in a neat row), read with ML Kit (on the phone,
 *    offline) and keep a small picture of each tab section
 */
@CapacitorPlugin(name = "TabScan")
public class TabScanPlugin extends Plugin {

    private static final String TAG = "FretlineScan";
    private static final int CHUNK_BYTES = 2 * 1024 * 1024;
    private static final byte[] POST_BODY = new byte[] { 0x78, 0 };
    private static boolean npInit;

    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final ConcurrentHashMap<String, Boolean> cancelled = new ConcurrentHashMap<>();
    private final ConcurrentHashMap<String, VideoStream> picked = new ConcurrentHashMap<>();
    private TextRecognizer recognizer;

    private static synchronized void initNewPipe() {
        if (!npInit) {
            NewPipe.init(NpDownloader.get(), new Localization("en", "IN"), new ContentCountry("IN"));
            npInit = true;
        }
    }

    private File scanDir() {
        File d = new File(getContext().getCacheDir(), "scan");
        //noinspection ResultOfMethodCallIgnored
        d.mkdirs();
        return d;
    }

    private File videoFile(String videoId) {
        return new File(scanDir(), videoId + ".video");
    }

    private File imageDir(String videoId) {
        File d = new File(new File(getContext().getFilesDir(), "tabimg"), videoId);
        //noinspection ResultOfMethodCallIgnored
        d.mkdirs();
        return d;
    }

    // --- Choosing and downloading the video ---------------------------------------

    /** The best picture-only stream up to maxHeight that Android can decode (mp4/H.264 first). */
    private VideoStream pick(String videoId, int maxHeight) throws Exception {
        String key = videoId + "@" + maxHeight;
        VideoStream cached = picked.get(key);
        if (cached != null) return cached;
        initNewPipe();
        StreamInfo info = StreamInfo.getInfo(ServiceList.YouTube, "https://www.youtube.com/watch?v=" + videoId);
        VideoStream best = null;
        int bestScore = Integer.MIN_VALUE;
        for (VideoStream s : info.getVideoOnlyStreams()) {
            if (!s.isUrl() || s.getDeliveryMethod() != DeliveryMethod.PROGRESSIVE_HTTP) continue;
            int h = s.getHeight();
            if (h <= 0 || h > maxHeight) continue;
            boolean mp4 = s.getFormat() == org.schabi.newpipe.extractor.MediaFormat.MPEG_4;
            String codec = s.getCodec() != null ? s.getCodec() : "";
            boolean avc = codec.startsWith("avc");
            // Taller is better (tab digits are small); H.264 decodes everywhere,
            // VP9 nearly everywhere, AV1 only on newer phones (last resort).
            boolean av1 = codec.startsWith("av01");
            int score = (av1 ? -100000 : 0) + h * 10 + (mp4 && avc ? 5 : 0) + (s.getFps() <= 30 ? 1 : 0);
            if (score > bestScore) {
                bestScore = score;
                best = s;
            }
        }
        if (best == null) throw new IOException("No downloadable video for " + videoId);
        picked.put(key, best);
        return best;
    }

    /**
     * Shrink a frame without losing thin lines: halve step by step (each
     * halving averages 2×2 pixels), then the last small step. One big
     * bilinear step skips rows, and a 1080p tab's thin lines vanish.
     */
    static Bitmap shrink(Bitmap src, int w, int h) {
        Bitmap cur = src;
        while (cur.getWidth() >= w * 2 && cur.getHeight() >= h * 2) {
            Bitmap half = Bitmap.createScaledBitmap(cur, cur.getWidth() / 2, cur.getHeight() / 2, true);
            if (cur != src) cur.recycle();
            cur = half;
        }
        if (cur.getWidth() == w && cur.getHeight() == h) return cur;
        Bitmap out = Bitmap.createScaledBitmap(cur, w, h, true);
        if (cur != src && cur != out) cur.recycle();
        return out;
    }

    @PluginMethod
    public void prepare(PluginCall call) {
        String videoId = call.getString("videoId");
        int maxHeight = call.getInt("maxHeight", 720);
        worker.execute(() -> {
            try {
                VideoStream s = pick(videoId, maxHeight);
                ItagItem itag = s.getItagItem();
                JSObject out = new JSObject();
                out.put("height", s.getHeight());
                out.put("width", s.getWidth());
                out.put("bytes", itag != null ? itag.getContentLength() : -1);
                out.put("downloaded", videoFile(videoId).isFile());
                call.resolve(out);
            } catch (Exception e) {
                Log.w(TAG, "prepare", e);
                call.reject(describe(e));
            }
        });
    }

    @PluginMethod
    public void download(PluginCall call) {
        String videoId = call.getString("videoId");
        int maxHeight = call.getInt("maxHeight", 720);
        cancelled.remove(videoId);
        worker.execute(() -> {
            File part = new File(scanDir(), videoId + ".part");
            File done = videoFile(videoId);
            try {
                if (done.isFile() && done.length() > 0) {
                    call.resolve(new JSObject());
                    return;
                }
                VideoStream s = pick(videoId, maxHeight);
                ItagItem itag = s.getItagItem();
                long total = itag != null ? itag.getContentLength() : -1;
                String url = s.getContent();
                try (OutputStream out = new FileOutputStream(part)) {
                    long pos = 0;
                    int rn = 0;
                    long lastEvent = 0;
                    while (total <= 0 || pos < total) {
                        if (Boolean.TRUE.equals(cancelled.get(videoId))) throw new IOException("Stopped");
                        long end = pos + CHUNK_BYTES - 1;
                        if (total > 0) end = Math.min(end, total - 1);
                        long wanted = end - pos + 1;
                        // Each piece is fetched whole before it's written, so a
                        // dropped connection can simply be tried again.
                        java.io.ByteArrayOutputStream piece = new java.io.ByteArrayOutputStream((int) wanted);
                        long got = -1;
                        IOException last = null;
                        for (int attempt = 0; attempt < 5 && got < 0; attempt++) {
                            if (Boolean.TRUE.equals(cancelled.get(videoId))) throw new IOException("Stopped");
                            if (attempt > 0) {
                                Thread.sleep(1000L << Math.min(attempt - 1, 3));
                                if (attempt == 2) {
                                    // The link may have gone stale: ask YouTube for a fresh one.
                                    picked.remove(videoId + "@" + maxHeight);
                                    VideoStream fresh = pick(videoId, maxHeight);
                                    ItagItem fi = fresh.getItagItem();
                                    long ft = fi != null ? fi.getContentLength() : -1;
                                    if (ft == total) url = fresh.getContent();
                                }
                            }
                            piece.reset();
                            try {
                                got = fetchRange(url, pos, end, rn++, piece);
                            } catch (IOException e) {
                                last = e;
                                Log.w(TAG, "download piece at " + pos + " failed (try " + (attempt + 1) + ")", e);
                            }
                        }
                        if (got < 0) throw last != null ? last : new IOException("Download failed");
                        piece.writeTo(out);
                        pos += got;
                        long now = System.currentTimeMillis();
                        if (now - lastEvent > 400) {
                            lastEvent = now;
                            progress(videoId, "download", pos, total);
                        }
                        if (got == 0 || got < wanted) break;
                    }
                    if (pos == 0) throw new IOException("The video came back empty");
                }
                if (!part.renameTo(done)) throw new IOException("Could not save the video");
                progress(videoId, "download", done.length(), done.length());
                call.resolve(new JSObject());
            } catch (Exception e) {
                //noinspection ResultOfMethodCallIgnored
                part.delete();
                Log.w(TAG, "download", e);
                call.reject(describe(e));
            }
        });
    }

    // --- The sound: to line the notes up with the plucks ---------------------------

    /** The smallest sound-only stream Android can decode (AAC in mp4 first). */
    private AudioStream pickAudio(String videoId) throws Exception {
        initNewPipe();
        StreamInfo info = StreamInfo.getInfo(ServiceList.YouTube, "https://www.youtube.com/watch?v=" + videoId);
        AudioStream best = null;
        int bestScore = Integer.MIN_VALUE;
        for (AudioStream a : info.getAudioStreams()) {
            if (!a.isUrl() || a.getDeliveryMethod() != DeliveryMethod.PROGRESSIVE_HTTP) continue;
            boolean m4a = a.getFormat() == org.schabi.newpipe.extractor.MediaFormat.M4A;
            int kbps = Math.max(1, a.getAverageBitrate());
            // small is fine (only the plucks matter); m4a decodes everywhere
            int score = (m4a ? 1000 : 0) - kbps;
            if (score > bestScore) {
                bestScore = score;
                best = a;
            }
        }
        if (best == null) throw new IOException("No sound stream for " + videoId);
        return best;
    }

    /**
     * Download the lesson's sound (small, deleted after), decode it and send
     * it to the app as 16-bit mono samples at `rate` per second, in "audio"
     * events of a few seconds each.
     */
    @PluginMethod
    public void audio(PluginCall call) {
        String videoId = call.getString("videoId");
        int rate = call.getInt("rate", 8000);
        cancelled.remove(videoId);
        worker.execute(() -> {
            File part = new File(scanDir(), videoId + ".apart");
            File file = new File(scanDir(), videoId + ".audio");
            try {
                if (!file.isFile() || file.length() == 0) {
                    AudioStream a = pickAudio(videoId);
                    ItagItem itag = a.getItagItem();
                    long total = itag != null ? itag.getContentLength() : -1;
                    String url = a.getContent();
                    try (OutputStream out = new FileOutputStream(part)) {
                        long pos = 0;
                        int rn = 0;
                        while (total <= 0 || pos < total) {
                            if (Boolean.TRUE.equals(cancelled.get(videoId))) throw new IOException("Stopped");
                            long end = pos + CHUNK_BYTES - 1;
                            if (total > 0) end = Math.min(end, total - 1);
                            long wanted = end - pos + 1;
                            java.io.ByteArrayOutputStream piece = new java.io.ByteArrayOutputStream((int) wanted);
                            long got = -1;
                            IOException last = null;
                            for (int attempt = 0; attempt < 5 && got < 0; attempt++) {
                                if (attempt > 0) Thread.sleep(1000L << Math.min(attempt - 1, 3));
                                piece.reset();
                                try {
                                    got = fetchRange(url, pos, end, rn++, piece);
                                } catch (IOException e) {
                                    last = e;
                                }
                            }
                            if (got < 0) throw last != null ? last : new IOException("Sound download failed");
                            piece.writeTo(out);
                            pos += got;
                            progress(videoId, "sound", pos, total);
                            if (got == 0 || got < wanted) break;
                        }
                    }
                    if (!part.renameTo(file)) throw new IOException("Could not save the sound");
                }
                long samples = decodeAudio(videoId, file, rate);
                JSObject out = new JSObject();
                out.put("rate", rate);
                out.put("samples", samples);
                call.resolve(out);
            } catch (Exception e) {
                Log.w(TAG, "audio", e);
                call.reject(describe(e));
            } finally {
                //noinspection ResultOfMethodCallIgnored
                part.delete();
                //noinspection ResultOfMethodCallIgnored
                file.delete();
            }
        });
    }

    /** Decode to mono at `rate` (averaging down), sending 5 s at a time. Returns the sample count. */
    private long decodeAudio(String videoId, File file, int rate) throws Exception {
        MediaExtractor ex = new MediaExtractor();
        MediaCodec dec = null;
        try {
            ex.setDataSource(file.getAbsolutePath());
            int track = -1;
            MediaFormat fmt = null;
            for (int i = 0; i < ex.getTrackCount(); i++) {
                MediaFormat f = ex.getTrackFormat(i);
                String mime = f.getString(MediaFormat.KEY_MIME);
                if (mime != null && mime.startsWith("audio/")) {
                    track = i;
                    fmt = f;
                    break;
                }
            }
            if (track < 0) throw new IOException("No sound in the download");
            ex.selectTrack(track);
            dec = MediaCodec.createDecoderByType(fmt.getString(MediaFormat.KEY_MIME));
            dec.configure(fmt, null, null, 0);
            dec.start();
            int srcRate = fmt.getInteger(MediaFormat.KEY_SAMPLE_RATE);
            int channels = fmt.getInteger(MediaFormat.KEY_CHANNEL_COUNT);
            short[] chunk = new short[rate * 5];
            int fill = 0;
            long sent = 0;
            double step = (double) srcRate / rate;
            double acc = 0;
            int accN = 0;
            double nextAt = step;
            long srcIndex = 0;
            MediaCodec.BufferInfo info = new MediaCodec.BufferInfo();
            boolean inputDone = false;
            boolean outputDone = false;
            while (!outputDone) {
                if (Boolean.TRUE.equals(cancelled.get(videoId))) throw new IOException("Stopped");
                if (!inputDone) {
                    int in = dec.dequeueInputBuffer(10_000);
                    if (in >= 0) {
                        ByteBuffer buf = dec.getInputBuffer(in);
                        int size = buf == null ? -1 : ex.readSampleData(buf, 0);
                        if (size < 0) {
                            dec.queueInputBuffer(in, 0, 0, 0, MediaCodec.BUFFER_FLAG_END_OF_STREAM);
                            inputDone = true;
                        } else {
                            dec.queueInputBuffer(in, 0, size, ex.getSampleTime(), 0);
                            ex.advance();
                        }
                    }
                }
                int outIx = dec.dequeueOutputBuffer(info, 10_000);
                if (outIx == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
                    MediaFormat of = dec.getOutputFormat();
                    srcRate = of.getInteger(MediaFormat.KEY_SAMPLE_RATE);
                    channels = of.getInteger(MediaFormat.KEY_CHANNEL_COUNT);
                    step = (double) srcRate / rate;
                    nextAt = srcIndex + step;
                } else if (outIx >= 0) {
                    ByteBuffer out = dec.getOutputBuffer(outIx);
                    if (out != null && info.size > 0) {
                        out.position(info.offset);
                        out.limit(info.offset + info.size);
                        java.nio.ShortBuffer sb = out.order(java.nio.ByteOrder.nativeOrder()).asShortBuffer();
                        int frames = sb.remaining() / Math.max(1, channels);
                        for (int f = 0; f < frames; f++) {
                            int sum = 0;
                            for (int c = 0; c < channels; c++) sum += sb.get();
                            acc += (double) sum / channels;
                            accN++;
                            srcIndex++;
                            if (srcIndex >= nextAt) {
                                chunk[fill++] = (short) Math.max(-32768, Math.min(32767, Math.round(acc / accN)));
                                acc = 0;
                                accN = 0;
                                nextAt += step;
                                if (fill == chunk.length) {
                                    sendAudio(videoId, sent, chunk, fill);
                                    sent += fill;
                                    fill = 0;
                                }
                            }
                        }
                    }
                    dec.releaseOutputBuffer(outIx, false);
                    if ((info.flags & MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0) outputDone = true;
                }
            }
            if (fill > 0) {
                sendAudio(videoId, sent, chunk, fill);
                sent += fill;
            }
            return sent;
        } finally {
            if (dec != null) {
                try {
                    dec.stop();
                } catch (Exception ignored) {
                    // already stopped
                }
                dec.release();
            }
            ex.release();
        }
    }

    private void sendAudio(String videoId, long start, short[] s, int n) {
        byte[] b = new byte[n * 2];
        for (int i = 0; i < n; i++) {
            b[2 * i] = (byte) (s[i] & 0xff);
            b[2 * i + 1] = (byte) ((s[i] >> 8) & 0xff);
        }
        JSObject e = new JSObject();
        e.put("videoId", videoId);
        e.put("start", start);
        e.put("pcm", Base64.encodeToString(b, Base64.NO_WRAP));
        notifyListeners("audio", e);
    }

    /** One ranged request (the way YouTube's own player asks), written to out. */
    private long fetchRange(String url, long start, long end, int rn, OutputStream out) throws IOException {
        String requestUrl = url + "&range=" + start + "-" + end + "&rn=" + rn;
        HttpURLConnection conn = (HttpURLConnection) new URL(requestUrl).openConnection();
        try {
            conn.setConnectTimeout(15_000);
            conn.setReadTimeout(20_000);
            conn.setRequestMethod("POST");
            conn.setDoOutput(true);
            conn.setFixedLengthStreamingMode(POST_BODY.length);
            if (YoutubeParsingHelper.isWebStreamingUrl(requestUrl)) {
                conn.setRequestProperty("Origin", "https://www.youtube.com");
                conn.setRequestProperty("Referer", "https://www.youtube.com/");
            }
            conn.setRequestProperty(
                "User-Agent",
                YoutubeParsingHelper.isVisionOsStreamingUrl(requestUrl)
                    ? YoutubeParsingHelper.getVisionOsUserAgent(null)
                    : NpDownloader.USER_AGENT
            );
            conn.setRequestProperty("Accept-Encoding", "identity");
            try (OutputStream body = conn.getOutputStream()) {
                body.write(POST_BODY);
            }
            int code = conn.getResponseCode();
            if (code == 416) return 0;
            if (code >= 400) throw new IOException("YouTube video request failed: HTTP " + code);
            long read = 0;
            byte[] buf = new byte[64 * 1024];
            try (InputStream in = conn.getInputStream()) {
                int n;
                while ((n = in.read(buf)) != -1) {
                    out.write(buf, 0, n);
                    read += n;
                }
            }
            return read;
        } finally {
            conn.disconnect();
        }
    }

    @PluginMethod
    public void cancel(PluginCall call) {
        String videoId = call.getString("videoId");
        if (videoId != null) cancelled.put(videoId, true);
        call.resolve();
    }

    @PluginMethod
    public void deleteVideo(PluginCall call) {
        String videoId = call.getString("videoId");
        //noinspection ResultOfMethodCallIgnored
        videoFile(videoId).delete();
        //noinspection ResultOfMethodCallIgnored
        new File(scanDir(), videoId + ".part").delete();
        //noinspection ResultOfMethodCallIgnored
        new File(scanDir(), videoId + ".audio").delete();
        //noinspection ResultOfMethodCallIgnored
        new File(scanDir(), videoId + ".apart").delete();
        picked.remove(videoId);
        call.resolve();
    }

    /** Delete the saved tab pictures for a lesson. */
    @PluginMethod
    public void deleteImages(PluginCall call) {
        File dir = imageDir(call.getString("videoId"));
        File[] files = dir.listFiles();
        if (files != null) for (File f : files) //noinspection ResultOfMethodCallIgnored
            f.delete();
        //noinspection ResultOfMethodCallIgnored
        dir.delete();
        call.resolve();
    }

    /**
     * The tab area at each requested time, as grey pixels (the app finds the
     * digits in it), with a picture of each kept for the lesson.
     */
    @PluginMethod
    public void areas(PluginCall call) {
        String videoId = call.getString("videoId");
        JSObject rect = call.getObject("rect");
        JSArray times = call.getArray("times");
        worker.execute(() -> {
            MediaMetadataRetriever r = new MediaMetadataRetriever();
            try {
                r.setDataSource(videoFile(videoId).getAbsolutePath());
                int rx = rect.getInteger("x", 0);
                int ry = rect.getInteger("y", 0);
                int rw = rect.getInteger("w", 0);
                int rh = rect.getInteger("h", 0);
                JSArray results = new JSArray();
                for (int i = 0; i < times.length(); i++) {
                    double t = times.getDouble(i);
                    Bitmap frame = frameAt(r, t);
                    if (frame == null) continue;
                    int x = Math.max(0, Math.min(frame.getWidth() - 1, rx));
                    int y = Math.max(0, Math.min(frame.getHeight() - 1, ry));
                    int w = Math.max(1, Math.min(frame.getWidth() - x, rw));
                    int h = Math.max(1, Math.min(frame.getHeight() - y, rh));
                    Bitmap area = Bitmap.createBitmap(frame, x, y, w, h);
                    File img = new File(imageDir(videoId), Math.round(t * 1000) + ".jpg");
                    try (OutputStream os = new FileOutputStream(img)) {
                        area.compress(Bitmap.CompressFormat.JPEG, 85, os);
                    }
                    JSObject res = new JSObject();
                    res.put("t", t);
                    res.put("x", x);
                    res.put("y", y);
                    res.put("w", w);
                    res.put("h", h);
                    res.put("gray", Base64.encodeToString(luma(area), Base64.NO_WRAP));
                    res.put("image", img.getAbsolutePath());
                    results.put(res);
                    area.recycle();
                    frame.recycle();
                    progress(videoId, "read", i + 1, times.length());
                }
                JSObject out = new JSObject();
                out.put("results", results);
                call.resolve(out);
            } catch (Exception e) {
                Log.w(TAG, "areas", e);
                call.reject(describe(e));
            } finally {
                try {
                    r.release();
                } catch (Exception ignored) {
                    // already released
                }
            }
        });
    }

    /**
     * The frame at t. Near the start of some videos the exact frame comes
     * back black; then the nearest key frame, or one a little later, is used.
     */
    private static Bitmap frameAt(MediaMetadataRetriever r, double t) {
        long us = (long) (t * 1e6);
        Bitmap b = r.getFrameAtTime(us, MediaMetadataRetriever.OPTION_CLOSEST);
        if (b != null && !mostlyBlack(b)) return b;
        long[] tries = { us, us + 300_000L, us + 700_000L };
        int[] opts = { MediaMetadataRetriever.OPTION_CLOSEST_SYNC, MediaMetadataRetriever.OPTION_CLOSEST, MediaMetadataRetriever.OPTION_NEXT_SYNC };
        for (int i = 0; i < tries.length; i++) {
            Bitmap c = r.getFrameAtTime(tries[i], opts[i]);
            if (c != null && !mostlyBlack(c)) {
                if (b != null) b.recycle();
                return c;
            }
            if (c != null) c.recycle();
        }
        return b;
    }

    private static boolean mostlyBlack(Bitmap b) {
        int w = b.getWidth();
        int h = b.getHeight();
        long sum = 0;
        int n = 0;
        for (int y = h / 8; y < h; y += Math.max(1, h / 16))
            for (int x = w / 16; x < w; x += Math.max(1, w / 32)) {
                int c = b.getPixel(x, y);
                sum += (Color.red(c) + Color.green(c) + Color.blue(c)) / 3;
                n++;
            }
        return n > 0 && sum / n < 12;
    }

    /** Read the text in a grey picture (the app's neat row of digits) with ML Kit. */
    @PluginMethod
    public void read(PluginCall call) {
        String gray = call.getString("gray", "");
        int w = call.getInt("w", 0);
        int h = call.getInt("h", 0);
        worker.execute(() -> {
            try {
                if (recognizer == null) recognizer = TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS);
                byte[] g = Base64.decode(gray, Base64.DEFAULT);
                if (w <= 0 || h <= 0 || g.length < w * h) throw new IOException("Bad picture size");
                int[] px = new int[w * h];
                for (int i = 0; i < px.length; i++) {
                    int v = g[i] & 0xff;
                    px[i] = 0xff000000 | (v << 16) | (v << 8) | v;
                }
                Bitmap bmp = Bitmap.createBitmap(px, w, h, Bitmap.Config.ARGB_8888);
                Text text = Tasks.await(recognizer.process(InputImage.fromBitmap(bmp, 0)));
                JSONArray chars = new JSONArray();
                for (Text.TextBlock block : text.getTextBlocks()) {
                    for (Text.Line line : block.getLines()) {
                        for (Text.Element el : line.getElements()) {
                            for (Text.Symbol sym : el.getSymbols()) {
                                Rect bx = sym.getBoundingBox();
                                if (bx == null) continue;
                                JSONObject c = new JSONObject();
                                c.put("c", sym.getText());
                                c.put("x", bx.left);
                                c.put("y", bx.top);
                                c.put("w", bx.width());
                                c.put("h", bx.height());
                                chars.put(c);
                            }
                        }
                    }
                }
                bmp.recycle();
                JSObject out = new JSObject();
                out.put("chars", chars);
                call.resolve(out);
            } catch (Exception e) {
                Log.w(TAG, "read", e);
                call.reject(describe(e));
            }
        });
    }

    /** Keep what the reader saw (characters per moment, pages, cursor) next to the pictures. */
    @PluginMethod
    public void saveReport(PluginCall call) {
        String videoId = call.getString("videoId");
        String json = call.getString("json", "{}");
        worker.execute(() -> {
            try (OutputStream os = new FileOutputStream(new File(imageDir(videoId), "report.json"))) {
                os.write(json.getBytes(java.nio.charset.StandardCharsets.UTF_8));
                call.resolve();
            } catch (Exception e) {
                call.reject(describe(e));
            }
        });
    }

    /** Share the reading details (report + tab pictures) as one zip, to send for checking. */
    @PluginMethod
    public void shareReport(PluginCall call) {
        String videoId = call.getString("videoId");
        worker.execute(() -> {
            try {
                File dir = imageDir(videoId);
                File[] files = dir.listFiles();
                if (files == null || files.length == 0) throw new IOException("Nothing read for this lesson yet");
                File outDir = new File(getContext().getCacheDir(), "share");
                //noinspection ResultOfMethodCallIgnored
                outDir.mkdirs();
                File zip = new File(outDir, "fretline-reading-" + videoId + ".zip");
                try (java.util.zip.ZipOutputStream z = new java.util.zip.ZipOutputStream(new FileOutputStream(zip))) {
                    byte[] buf = new byte[64 * 1024];
                    for (File f : files) {
                        z.putNextEntry(new java.util.zip.ZipEntry(f.getName()));
                        try (InputStream in = new java.io.FileInputStream(f)) {
                            int n;
                            while ((n = in.read(buf)) != -1) z.write(buf, 0, n);
                        }
                        z.closeEntry();
                    }
                }
                android.net.Uri uri = androidx.core.content.FileProvider.getUriForFile(
                    getContext(), getContext().getPackageName() + ".fileprovider", zip);
                android.content.Intent send = new android.content.Intent(android.content.Intent.ACTION_SEND);
                send.setType("application/zip");
                send.putExtra(android.content.Intent.EXTRA_STREAM, uri);
                send.addFlags(android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION);
                android.content.Intent chooser = android.content.Intent.createChooser(send, "Send reading details");
                chooser.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK);
                getActivity().runOnUiThread(() -> getContext().startActivity(chooser));
                call.resolve();
            } catch (Exception e) {
                Log.w(TAG, "shareReport", e);
                call.reject(describe(e));
            }
        });
    }

    private void progress(String videoId, String phase, long done, long total) {
        JSObject p = new JSObject();
        p.put("videoId", videoId);
        p.put("phase", phase);
        p.put("done", done);
        p.put("total", total);
        notifyListeners("progress", p);
    }

    // --- Overview: a few small grey frames ---------------------------------------

    @PluginMethod
    public void overview(PluginCall call) {
        String videoId = call.getString("videoId");
        int count = call.getInt("count", 16);
        int width = call.getInt("width", 640);
        worker.execute(() -> {
            MediaMetadataRetriever r = new MediaMetadataRetriever();
            try {
                r.setDataSource(videoFile(videoId).getAbsolutePath());
                long durUs = Long.parseLong(r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)) * 1000L;
                int srcW = Integer.parseInt(r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_WIDTH));
                int srcH = Integer.parseInt(r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_HEIGHT));
                JSArray frames = new JSArray();
                for (int i = 0; i < count; i++) {
                    long t = durUs * (i + 1) / (count + 1);
                    Bitmap b = r.getFrameAtTime(t, MediaMetadataRetriever.OPTION_CLOSEST_SYNC);
                    if (b == null) continue;
                    int w = Math.min(width, b.getWidth());
                    int h = Math.round((float) b.getHeight() * w / b.getWidth());
                    Bitmap small = shrink(b, w, h);
                    JSObject f = new JSObject();
                    f.put("t", t / 1e6);
                    f.put("w", w);
                    f.put("h", h);
                    f.put("gray", Base64.encodeToString(luma(small), Base64.NO_WRAP));
                    frames.put(f);
                    if (small != b) small.recycle();
                    b.recycle();
                }
                JSObject out = new JSObject();
                out.put("width", srcW);
                out.put("height", srcH);
                out.put("durationSec", durUs / 1e6);
                out.put("frames", frames);
                call.resolve(out);
            } catch (Exception e) {
                Log.w(TAG, "overview", e);
                call.reject(describe(e));
            } finally {
                try {
                    r.release();
                } catch (Exception ignored) {
                    // already released
                }
            }
        });
    }

    private static byte[] luma(Bitmap b) {
        int w = b.getWidth();
        int h = b.getHeight();
        int[] px = new int[w * h];
        b.getPixels(px, 0, w, 0, 0, w, h);
        byte[] out = new byte[w * h];
        for (int i = 0; i < px.length; i++) {
            int c = px[i];
            int y = (77 * Color.red(c) + 150 * Color.green(c) + 29 * Color.blue(c)) >> 8;
            out[i] = (byte) y;
        }
        return out;
    }

    // --- Features: one pass over the whole video ---------------------------------

    /**
     * Decodes the video once. `fps` times a second, measures the tab area
     * (rect, in video pixels): for each of `cols` columns the mean brightness
     * (Y), mean blue-yellow (Cb) and red-cyan (Cr), plus a 64×12 grey thumbnail. Sent in
     * batches as "features" events; resolves when the video ends.
     */
    @PluginMethod
    public void features(PluginCall call) {
        String videoId = call.getString("videoId");
        JSObject rect = call.getObject("rect");
        double fps = call.getDouble("fps", 4.0);
        int cols = call.getInt("cols", 480);
        cancelled.remove(videoId);
        worker.execute(() -> {
            MediaExtractor ex = new MediaExtractor();
            MediaCodec dec = null;
            try {
                ex.setDataSource(videoFile(videoId).getAbsolutePath());
                int track = -1;
                MediaFormat fmt = null;
                for (int i = 0; i < ex.getTrackCount(); i++) {
                    MediaFormat f = ex.getTrackFormat(i);
                    String mime = f.getString(MediaFormat.KEY_MIME);
                    if (mime != null && mime.startsWith("video/")) {
                        track = i;
                        fmt = f;
                        break;
                    }
                }
                if (track < 0) throw new IOException("No video in the file");
                ex.selectTrack(track);
                long durUs = fmt.containsKey(MediaFormat.KEY_DURATION) ? fmt.getLong(MediaFormat.KEY_DURATION) : 0;
                dec = MediaCodec.createDecoderByType(fmt.getString(MediaFormat.KEY_MIME));
                fmt.setInteger(MediaFormat.KEY_COLOR_FORMAT, MediaCodecInfo.CodecCapabilities.COLOR_FormatYUV420Flexible);
                dec.configure(fmt, null, null, 0);
                dec.start();

                int rx = rect.getInteger("x", 0);
                int ry = rect.getInteger("y", 0);
                int rw = rect.getInteger("w", 0);
                int rh = rect.getInteger("h", 0);
                long stepUs = (long) (1_000_000 / Math.max(0.5, fps));
                long nextUs = 0;
                MediaCodec.BufferInfo info = new MediaCodec.BufferInfo();
                boolean inputDone = false;
                JSArray batch = new JSArray();
                long lastProgress = 0;
                while (true) {
                    if (Boolean.TRUE.equals(cancelled.get(videoId))) throw new IOException("Stopped");
                    if (!inputDone) {
                        int in = dec.dequeueInputBuffer(10_000);
                        if (in >= 0) {
                            ByteBuffer buf = dec.getInputBuffer(in);
                            int size = buf != null ? ex.readSampleData(buf, 0) : -1;
                            if (size < 0) {
                                dec.queueInputBuffer(in, 0, 0, 0, MediaCodec.BUFFER_FLAG_END_OF_STREAM);
                                inputDone = true;
                            } else {
                                dec.queueInputBuffer(in, 0, size, ex.getSampleTime(), 0);
                                ex.advance();
                            }
                        }
                    }
                    int out = dec.dequeueOutputBuffer(info, 10_000);
                    if (out >= 0) {
                        boolean eos = (info.flags & MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0;
                        if (info.size > 0 && info.presentationTimeUs >= nextUs) {
                            Image img = dec.getOutputImage(out);
                            if (img != null) {
                                batch.put(measure(img, info.presentationTimeUs / 1e6, rx, ry, rw, rh, cols));
                                img.close();
                            }
                            nextUs = info.presentationTimeUs + stepUs;
                        }
                        dec.releaseOutputBuffer(out, false);
                        if (batch.length() >= 40) {
                            sendBatch(videoId, batch);
                            batch = new JSArray();
                        }
                        long now = System.currentTimeMillis();
                        if (now - lastProgress > 500) {
                            lastProgress = now;
                            progress(videoId, "look", info.presentationTimeUs / 1000, durUs / 1000);
                        }
                        if (eos) break;
                    }
                }
                if (batch.length() > 0) sendBatch(videoId, batch);
                call.resolve(new JSObject());
            } catch (Exception e) {
                Log.w(TAG, "features", e);
                call.reject(describe(e));
            } finally {
                if (dec != null) {
                    try {
                        dec.stop();
                    } catch (Exception ignored) {
                        // already stopped
                    }
                    dec.release();
                }
                ex.release();
            }
        });
    }

    private void sendBatch(String videoId, JSArray frames) {
        JSObject b = new JSObject();
        b.put("videoId", videoId);
        b.put("frames", frames);
        notifyListeners("features", b);
    }

    /** Size of the tab-area thumbnail used to spot page changes. */
    private static final int MW = 64;
    private static final int MH = 12;

    /** Column profiles of the tab area in one decoded frame. */
    private static JSObject measure(Image img, double t, int rx, int ry, int rw, int rh, int cols) {
        Image.Plane[] planes = img.getPlanes();
        Rect crop = img.getCropRect();
        int W = crop.width();
        int H = crop.height();
        int x0 = Math.max(0, Math.min(W - 1, rx));
        int y0 = Math.max(0, Math.min(H - 1, ry));
        int x1 = Math.max(x0 + 1, Math.min(W, rx + rw));
        int y1 = Math.max(y0 + 1, Math.min(H, ry + rh));

        ByteBuffer Y = planes[0].getBuffer();
        int yRow = planes[0].getRowStride();
        int yPix = planes[0].getPixelStride();
        ByteBuffer U = planes[1].getBuffer();
        int uRow = planes[1].getRowStride();
        int uPix = planes[1].getPixelStride();
        ByteBuffer V = planes[2].getBuffer();
        int vRow = planes[2].getRowStride();
        int vPix = planes[2].getPixelStride();

        long[] ySum = new long[cols];
        long[] uSum = new long[cols];
        long[] vSum = new long[cols];
        int[] yN = new int[cols];
        int[] uN = new int[cols];
        long[] mini = new long[MW * MH];
        int[] miniN = new int[MW * MH];
        int bw = x1 - x0;
        int bh = y1 - y0;
        for (int y = y0; y < y1; y += 2) {
            int rowY = (crop.top + y) * yRow;
            int rowU = ((crop.top + y) / 2) * uRow;
            int rowV = ((crop.top + y) / 2) * vRow;
            int my = Math.min(MH - 1, (y - y0) * MH / bh);
            for (int x = x0; x < x1; x++) {
                int c = Math.min(cols - 1, (x - x0) * cols / bw);
                int v = Y.get(rowY + (crop.left + x) * yPix) & 0xff;
                ySum[c] += v;
                yN[c]++;
                int mx = Math.min(MW - 1, (x - x0) * MW / bw);
                mini[my * MW + mx] += v;
                miniN[my * MW + mx]++;
                if ((x & 1) == 0) {
                    uSum[c] += U.get(rowU + ((crop.left + x) / 2) * uPix) & 0xff;
                    vSum[c] += V.get(rowV + ((crop.left + x) / 2) * vPix) & 0xff;
                    uN[c]++;
                }
            }
        }
        byte[] yb = new byte[cols];
        byte[] ub = new byte[cols];
        byte[] vb = new byte[cols];
        for (int c = 0; c < cols; c++) {
            yb[c] = (byte) (yN[c] > 0 ? ySum[c] / yN[c] : 0);
            ub[c] = (byte) (uN[c] > 0 ? uSum[c] / uN[c] : 128);
            vb[c] = (byte) (uN[c] > 0 ? vSum[c] / uN[c] : 128);
        }
        byte[] mb = new byte[MW * MH];
        for (int i = 0; i < mb.length; i++) mb[i] = (byte) (miniN[i] > 0 ? mini[i] / miniN[i] : 0);
        JSObject f = new JSObject();
        f.put("t", t);
        f.put("y", Base64.encodeToString(yb, Base64.NO_WRAP));
        f.put("u", Base64.encodeToString(ub, Base64.NO_WRAP));
        f.put("v", Base64.encodeToString(vb, Base64.NO_WRAP));
        f.put("m", Base64.encodeToString(mb, Base64.NO_WRAP));
        return f;
    }

    private static String describe(Throwable e) {
        String msg = e.getMessage();
        return e.getClass().getSimpleName() + (msg != null ? ": " + msg : "");
    }
}
