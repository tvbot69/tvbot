declare module 'ffprobe-static' {
  const ffprobeStatic: {
    path: string;
  };
  export default ffprobeStatic;
}

declare module 'fluent-ffmpeg' {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ffmpeg: any;
  export default ffmpeg;
}
