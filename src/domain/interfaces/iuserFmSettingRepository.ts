export interface UserFmSetting {
  userId: number;
  embedType: number;
  footerOptions: bigint;
  buttons: bigint;
  accentColor: number | null;
  customColor: string | null;
  smallTextType: number | null;
  privateButtonResponse: boolean | null;
  modified: Date | null;
}

export interface IUserFmSettingRepository {
  get(userId: number): Promise<UserFmSetting | null>;
  getOrCreate(userId: number): Promise<UserFmSetting>;
  setEmbedType(userId: number, embedType: number): Promise<UserFmSetting>;
  setFooterOptions(userId: number, footerOptions: bigint): Promise<UserFmSetting>;
  setButtons(userId: number, buttons: bigint): Promise<UserFmSetting>;
  setAccentColor(userId: number, accentColor: number | null, customColor?: string | null): Promise<UserFmSetting>;
  setSmallTextType(userId: number, smallTextType: number | null): Promise<UserFmSetting>;
  setPrivateButtonResponse(userId: number, value: boolean | null): Promise<UserFmSetting>;
}
