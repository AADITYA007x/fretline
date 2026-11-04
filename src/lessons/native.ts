// The phone app's lesson reader (android LessonInfoPlugin): details,
// chapters and captions from YouTube without an API key. In a browser it
// isn't there, unless a test provides a stand-in.
import { registerPlugin } from "@capacitor/core";
import type { CaptionTrack } from "./captions";
import type { Chapter } from "./store";

export interface LessonInfo {
  videoId: string;
  title: string;
  uploader: string;
  durationSec: number;
  thumbnail: string | null;
  chapters: Chapter[];
  captions: CaptionTrack[];
}

interface LessonInfoPlugin {
  info(o: { videoId: string }): Promise<LessonInfo>;
  fetchText(o: { url: string }): Promise<{ text: string }>;
}

type Fake = Partial<LessonInfoPlugin>;

function fake(): Fake | undefined {
  return (window as unknown as { __fretlineFakeLessonInfo?: Fake }).__fretlineFakeLessonInfo;
}

export const lessonInfo = registerPlugin<LessonInfoPlugin>("LessonInfo", {
  web: () => ({
    info: (o: { videoId: string }) => fake()?.info?.(o) ?? Promise.reject(new Error("Lesson details load in the phone app.")),
    fetchText: (o: { url: string }) => fake()?.fetchText?.(o) ?? Promise.reject(new Error("Captions load in the phone app.")),
  }),
});
