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
import org.schabi.newpipe.extractor.stream.VideoStream;

/**
 * Reading the tab shown in a lesson video. The video is downloaded once
 * (picture only) into the app's private cache, looked at, and deleted.
 *
 * The app's TypeScript does the thinking (where the tab is, when pages
 * change, where the cursor is); this side does the heavy lifting:
 *  - prepare/download: pick a 720p-or-lower video-only stream and fetch it
 *  - overview: a few frames as small grey pictures, to find the tab
 *  - features: decode the whole video once and, a few times a second,
 *    measure the tab area (brightness and blue/yellow per column, plus a
 *    tiny picture to spot page changes)
 *  - ocr: read the digits on chosen frames with ML Kit (on the phone,
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

    /** The best picture-only stream up to 720p that Android can decode (mp4/H.264 first). */
    private VideoStream pick(String videoId) throws Exception {
        VideoStream cached = picked.get(videoId);
        if (cached != null) return cached;
        initNewPipe();
        StreamInfo info = StreamInfo.getInfo(ServiceList.YouTube, "https://www.youtube.com/watch?v=" + videoId);
        VideoStream best = null;
        int bestScore = Integer.MIN_VALUE;
        for (VideoStream s : info.getVideoOnlyStreams()) {
            if (!s.isUrl() || s.getDeliveryMethod() != DeliveryMethod.PROGRESSIVE_HTTP) continue;
            int h = s.getHeight();
            if (h <= 0 || h > 720) continue;
            boolean mp4 = s.getFormat() == org.schabi.newpipe.extractor.MediaFormat.MPEG_4;
            String codec = s.getCodec() != null ? s.getCodec() : "";
            boolean avc = codec.startsWith("avc");
            // Taller is better (tab digits are small); H.264 decodes everywhere.
            int score = h * 10 + (mp4 && avc ? 5 : 0) + (s.getFps() <= 30 ? 1 : 0);
            if (score > bestScore) {
                bestScore = score;
                best = s;
            }
        }
        if (best == null) throw new IOException("No downloadable video for " + videoId);
        picked.put(videoId, best);
        return best;
    }

    @PluginMethod
    public void prepare(PluginCall call) {
        String videoId = call.getString("videoId");
        worker.execute(() -> {
            try {
                VideoStream s = pick(videoId);
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
        cancelled.remove(videoId);
        worker.execute(() -> {
            File part = new File(scanDir(), videoId + ".part");
            File done = videoFile(videoId);
            try {
                if (done.isFile() && done.length() > 0) {
                    call.resolve(new JSObject());
                    return;
                }
                VideoStream s = pick(videoId);
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
                        long got = fetchRange(url, pos, end, rn++, out);
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
                    Bitmap small = Bitmap.createScaledBitmap(b, w, h, true);
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

    // --- OCR: read the digits on chosen frames -----------------------------------

    /**
     * For each requested time: the frame's tab area (rect), enlarged `scale`×,
     * read by ML Kit. Returns every character with its box (in video pixels)
     * and saves the area as a small JPEG for the app to show.
     */
    @PluginMethod
    public void ocr(PluginCall call) {
        String videoId = call.getString("videoId");
        JSObject rect = call.getObject("rect");
        JSArray times = call.getArray("times");
        JSArray linesArg = call.getArray("lines");
        double scale = call.getDouble("scale", 2.0);
        worker.execute(() -> {
            MediaMetadataRetriever r = new MediaMetadataRetriever();
            try {
                if (recognizer == null) recognizer = TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS);
                r.setDataSource(videoFile(videoId).getAbsolutePath());
                int rx = rect.getInteger("x", 0);
                int ry = rect.getInteger("y", 0);
                int rw = rect.getInteger("w", 0);
                int rh = rect.getInteger("h", 0);
                JSArray results = new JSArray();
                for (int i = 0; i < times.length(); i++) {
                    double t = times.getDouble(i);
                    Bitmap frame = r.getFrameAtTime((long) (t * 1e6), MediaMetadataRetriever.OPTION_CLOSEST);
                    if (frame == null) continue;
                    int x = Math.max(0, Math.min(frame.getWidth() - 1, rx));
                    int y = Math.max(0, Math.min(frame.getHeight() - 1, ry));
                    int w = Math.max(1, Math.min(frame.getWidth() - x, rw));
                    int h = Math.max(1, Math.min(frame.getHeight() - y, rh));
                    Bitmap area = Bitmap.createBitmap(frame, x, y, w, h);
                    double[] lines = new double[6];
                    for (int k = 0; k < 6 && linesArg != null && k < linesArg.length(); k++) lines[k] = linesArg.getDouble(k) - y;
                    Bitmap cleaned = linesArg != null && linesArg.length() == 6 ? cleanTab(area, lines) : area;
                    Bitmap big = Bitmap.createScaledBitmap(cleaned, (int) (w * scale), (int) (h * scale), true);
                    Text text = Tasks.await(recognizer.process(InputImage.fromBitmap(big, 0)));
                    JSONArray chars = new JSONArray();
                    for (Text.TextBlock block : text.getTextBlocks()) {
                        for (Text.Line line : block.getLines()) {
                            for (Text.Element el : line.getElements()) {
                                for (Text.Symbol sym : el.getSymbols()) {
                                    Rect bx = sym.getBoundingBox();
                                    if (bx == null) continue;
                                    JSONObject c = new JSONObject();
                                    c.put("c", sym.getText());
                                    c.put("x", x + bx.left / scale);
                                    c.put("y", y + bx.top / scale);
                                    c.put("w", bx.width() / scale);
                                    c.put("h", bx.height() / scale);
                                    c.put("conf", sym.getConfidence());
                                    chars.put(c);
                                }
                            }
                        }
                    }
                    File img = new File(imageDir(videoId), Math.round(t * 1000) + ".jpg");
                    try (OutputStream os = new FileOutputStream(img)) {
                        area.compress(Bitmap.CompressFormat.JPEG, 80, os);
                    }
                    JSObject res = new JSObject();
                    res.put("t", t);
                    res.put("chars", chars);
                    res.put("image", img.getAbsolutePath());
                    results.put(res);
                    if (big != cleaned) big.recycle();
                    if (cleaned != area) cleaned.recycle();
                    area.recycle();
                    frame.recycle();
                    progress(videoId, "read", i + 1, times.length());
                }
                JSObject out = new JSObject();
                out.put("results", results);
                call.resolve(out);
            } catch (Exception e) {
                Log.w(TAG, "ocr", e);
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
     * Remove the staff lines and stems/bar lines (long thin runs) so only
     * the digits are left for the text reader. Same as src/scan/clean.ts.
     */
    static Bitmap cleanTab(Bitmap area, double[] lines) {
        int w = area.getWidth();
        int h = area.getHeight();
        byte[] lum = luma(area);
        int[] g = new int[w * h];
        for (int i = 0; i < g.length; i++) g[i] = lum[i] & 0xff;
        int[] sorted = g.clone();
        java.util.Arrays.sort(sorted);
        int bg = sorted[(int) (sorted.length * 0.9)];
        int dark = bg - 25;
        double spacing = (lines[5] - lines[0]) / 5.0;
        for (double ly : lines) {
            for (int y = (int) Math.round(ly) - 2; y <= (int) Math.round(ly) + 2; y++) {
                if (y < 0 || y >= h) continue;
                int x = 0;
                while (x < w) {
                    if (g[y * w + x] >= dark) {
                        x++;
                        continue;
                    }
                    int s = x;
                    while (x < w && g[y * w + x] < dark) x++;
                    if (x - s > spacing * 1.5) for (int k = s; k < x; k++) g[y * w + k] = bg;
                }
            }
        }
        for (int x = 0; x < w; x++) {
            int y = 0;
            while (y < h) {
                if (g[y * w + x] >= dark) {
                    y++;
                    continue;
                }
                int s = y;
                while (y < h && g[y * w + x] < dark) y++;
                if (y - s > spacing * 1.6) for (int k = s; k < y; k++) g[k * w + x] = bg;
            }
        }
        int[] px = new int[w * h];
        for (int i = 0; i < px.length; i++) px[i] = 0xff000000 | (g[i] << 16) | (g[i] << 8) | g[i];
        return Bitmap.createBitmap(px, w, h, Bitmap.Config.ARGB_8888);
    }

    private static String describe(Throwable e) {
        String msg = e.getMessage();
        return e.getClass().getSimpleName() + (msg != null ? ": " + msg : "");
    }
}
