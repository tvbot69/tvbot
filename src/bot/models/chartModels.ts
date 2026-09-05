import type { TopAlbum, TopArtist, TopTrack } from '@domain/models/topLists';
import type { TimeSettingsModel } from '@domain/models/timeSettings';

export enum TitleSetting {
  Titles = 'Titles',
  TitlesDisabled = 'TitlesDisabled',
}

export class ChartSettings {
  public albums?: TopAlbum[];
  public artists?: TopArtist[];
  public tracks?: TopTrack[];
  public artistChart: boolean = false;
  public trackChart: boolean = false;

  private _height: number = 0;
  private _width: number = 0;
  public imagesNeeded: number = 9;

  public get height(): number {
    return this._height;
  }

  public set height(value: number) {
    this._height = value;
    this.imagesNeeded = this._width * this._height;
  }

  public get width(): number {
    return this._width;
  }

  public set width(value: number) {
    this._width = value;
    this.imagesNeeded = this._width * this._height;
  }

  public timeSettings?: TimeSettingsModel;
  public timespanString: string = 'Alltime';
  public titleSetting: TitleSetting = TitleSetting.Titles;
  public skipWithoutImage: boolean = false;
  public skipNsfw: boolean = false;
  public rainbowSortingEnabled: boolean = false;
  public filterSingles: boolean = false;
  public releaseYearFilter?: number;
  public releaseDecadeFilter?: number;
  public filteredArtistName?: string;
  public customOptionsEnabled: boolean = false;
}

export const DefaultChartSize = 3;
