export enum ResponseMode {
  Embed = 1,
  Image = 2,
}

export const ResponseModeNames: Record<ResponseMode, string> = {
  [ResponseMode.Embed]: 'Embed',
  [ResponseMode.Image]: 'Image',
};
