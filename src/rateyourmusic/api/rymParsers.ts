import { load, type Cheerio, type CheerioAPI } from 'cheerio';
import type { Element } from 'domhandler';
import type { RymArtist, RymRelease, RymReleaseStub, RymTrack } from '../models/rymModels';
import {
  absoluteUrl,
  artistSlugFromUrl,
  cleanText,
  parseCount,
  parseRating,
  parseYear,
  releaseSlugFromUrl,
  releaseTypeFromUrl,
} from './rymClean';

const abs = (url: string | undefined): string => absoluteUrl(url ?? '');

const uniqueClean = (values: Array<string | null | undefined>): string[] => {
  const out: string[] = [];
  for (const value of values) {
    const cleaned = value ? cleanText(value) : '';
    if (cleaned && !out.includes(cleaned)) {
      out.push(cleaned);
    }
  }
  return out;
};

const textsFromSelection = ($: CheerioAPI, selection: Cheerio<Element>): string[] =>
  uniqueClean(selection.toArray().map((el) => $(el).text()));

export const parseChartPage = (html: string): RymReleaseStub[] => {
  const $ = load(html);
  const out: RymReleaseStub[] = [];
  $('.page_charts_section_charts_item').each((idx, item) => {
    const $item = $(item);
    const link = $item
      .find('a.page_charts_section_charts_item_link.release')
      .first();
    const fallbackLink = $item.find('a[href*="/release/"]').first();
    const chosen = link.length > 0 ? link : fallbackLink;
    const href = chosen.attr('href');
    if (!href) {
      return;
    }
    const url = abs(href);
    const rymId = releaseSlugFromUrl(url);
    if (!rymId) {
      return;
    }

    const credited = $item
      .find('.page_charts_section_charts_item_credited_links_primary')
      .first();
    const creditedText = $item
      .find('.page_charts_section_charts_item_credited_text')
      .first();
    const artistAnchor = $item
      .find('.page_charts_section_charts_item_credited_links_primary a.artist')
      .first();
    const anyArtistAnchor = $item.find('a.artist').first();
    const creditedEl = credited.length > 0 ? credited : creditedText;
    const artistAnchorEl = artistAnchor.length > 0 ? artistAnchor : anyArtistAnchor;
    const artist = cleanText(
      creditedEl.length > 0 ? creditedEl.text() : artistAnchorEl.text(),
    );
    const artistId =
      artistAnchorEl.length > 0
        ? artistSlugFromUrl(abs(artistAnchorEl.attr('href')))
        : '';

    const dateEl = $item
      .find('.page_charts_section_charts_item_title_date_compact span')
      .first();
    const dateFallback = $item
      .find('.page_charts_section_charts_item_date span')
      .first();
    const date = cleanText(
      dateEl.length > 0 ? dateEl.text() : dateFallback.text(),
    );

    const releaseTypeEl = $item
      .find('.page_charts_section_charts_item_release_type')
      .first();
    const releaseType =
      releaseTypeEl.length > 0
        ? cleanText(releaseTypeEl.text()).toLowerCase()
        : releaseTypeFromUrl(url);

    const primary = textsFromSelection(
      $,
      $item.find('.page_charts_section_charts_item_genres_primary a.genre'),
    );
    const secondary = textsFromSelection(
      $,
      $item.find('.page_charts_section_charts_item_genres_secondary a.genre'),
    );
    const descriptors = textsFromSelection(
      $,
      $item.find(
        '.page_charts_section_charts_item_genre_descriptors span, .page_charts_section_charts_item_genre_descriptors a',
      ),
    );

    const ratingEl = $item
      .find('.page_charts_section_charts_item_details_average_num')
      .first();
    const nRatingsEl = $item
      .find('.page_charts_section_charts_item_details_ratings .abbr')
      .first();
    const nRatingsFallback = $item
      .find('.page_charts_section_charts_item_details_ratings')
      .first();
    const nReviewsEl = $item
      .find('.page_charts_section_charts_item_details_reviews .abbr')
      .first();
    const img = $item
      .find('.page_charts_section_charts_item_image img')
      .first();

    out.push({
      rymId,
      title: cleanText(chosen.text()),
      artist,
      url,
      artistId,
      releaseType: releaseType || 'album',
      year: parseYear(date),
      date,
      rating: ratingEl.length > 0 ? parseRating(ratingEl.text()) : null,
      nRatings:
        nRatingsEl.length > 0
          ? parseCount(nRatingsEl.text())
          : nRatingsFallback.length > 0
            ? parseCount(nRatingsFallback.text())
            : null,
      nReviews: nReviewsEl.length > 0 ? parseCount(nReviewsEl.text()) : null,
      primaryGenres: primary,
      secondaryGenres: secondary,
      descriptors,
      coverUrl: abs(img.attr('src')),
      position: idx + 1,
    });
  });
  return out;
};

const ARTIST_INFO_KEYS: Record<string, 'formed' | 'located' | 'members' | 'aliases' | 'genres' | 'related' | 'notes'> = {
  formed: 'formed',
  born: 'formed',
  located: 'located',
  currently: 'located',
  members: 'members',
  member: 'members',
  'also known as': 'aliases',
  aka: 'aliases',
  'related artists': 'related',
  genres: 'genres',
  genre: 'genres',
  notes: 'notes',
};

const listField = (
  $: CheerioAPI,
  val: Cheerio<Element>,
  members: boolean,
): string[] => {
  const anchors = uniqueClean(val.find('a').toArray().map((el) => $(el).text()));
  if (members) {
    if (anchors.length > 0) {
      return anchors;
    }
    return uniqueClean(cleanText(val.text()).split(/,(?![^(]*\))/));
  }
  const parts = cleanText(val.text()).split(/\s*[,/]\s*/);
  return uniqueClean(parts.length > 0 ? parts : anchors);
};

export const parseArtistPage = (html: string, slug: string): RymArtist => {
  const $ = load(html);

  const name =
    cleanText($('h1.artist_name_hdr').first().text()) ||
    cleanText($('h1').first().text());
  const info: {
    formed: string;
    located: string;
    members: string[];
    aliases: string[];
    genres: string[];
    related: string[];
    notes: string;
  } = {
    formed: '',
    located: '',
    members: [],
    aliases: [],
    genres: [],
    related: [],
    notes: '',
  };

  $('.artist_info').first().find('.info_hdr').each((_, hdr) => {
    const key = cleanText($(hdr).text()).toLowerCase();
    let field = ARTIST_INFO_KEYS[key];
    if (!field) {
      for (const k of Object.keys(ARTIST_INFO_KEYS)) {
        if (key.includes(k)) {
          field = ARTIST_INFO_KEYS[k];
          break;
        }
      }
    }
    if (!field) {
      return;
    }
    const val = $(hdr).next();
    if (!val.length) {
      return;
    }
    if (field === 'members' || field === 'aliases' || field === 'related' || field === 'genres') {
      info[field] = listField($, val, field === 'members');
    } else {
      info[field] = cleanText(val.text());
    }
  });

  const discography: RymReleaseStub[] = [];
  const seen = new Set<string>();
  $('.disco_release').each((_, row) => {
    const $row = $(row);
    const a =
      $row.find('a.album').first().length > 0
        ? $row.find('a.album').first()
        : $row.find('a[href*="/release/"]').first();
    const href = a.attr('href');
    if (!href) {
      return;
    }
    const url = abs(href);
    const rymId = releaseSlugFromUrl(url);
    if (!rymId || seen.has(rymId)) {
      return;
    }
    seen.add(rymId);
    const yearEl = $row.find('.disco_year_ymd, .disco_year').first();
    const yearText = yearEl.attr('title') ?? yearEl.text();
    const ratingEl = $row.find('.disco_avg_rating').first();
    const nRatingsEl = $row.find('.disco_ratings').first();
    const nReviewsEl = $row.find('.disco_reviews').first();
    const img = $row.find('img.image_release').first();
    discography.push({
      rymId,
      title: cleanText(a.text()) || cleanText(a.attr('title') ?? ''),
      artist: name,
      url,
      artistId: slug,
      releaseType: releaseTypeFromUrl(url),
      year: parseYear(yearText),
      date: yearEl.length > 0 ? cleanText(yearEl.attr('title') ?? yearEl.text()) : '',
      rating: ratingEl.length > 0 ? parseRating(ratingEl.text()) : null,
      nRatings: nRatingsEl.length > 0 ? parseCount(nRatingsEl.text()) : null,
      nReviews: nReviewsEl.length > 0 ? parseCount(nReviewsEl.text()) : null,
      primaryGenres: [],
      secondaryGenres: [],
      descriptors: [],
      coverUrl: abs(img.attr('src')),
      position: null,
    });
  });

  return {
    rymId: slug,
    name,
    url: `https://rateyourmusic.com/artist/${slug}/`,
    formed: info.formed,
    located: info.located,
    members: info.members,
    aliases: info.aliases,
    genres: info.genres,
    related: info.related,
    notes: info.notes,
    discography,
  };
};

const parseTracklist = ($: CheerioAPI): RymTrack[] => {
  const out: RymTrack[] = [];
  const seen = new Set<string>();
  let rows = $('#tracks .tracklist_line, #tracks li.track');
  if (rows.length === 0) {
    rows = $('.tracklist_line, li.track');
  }
  rows.each((_, row) => {
    const $row = $(row);
    const numEl = $row.find('.tracklist_num, .track_num, .num').first();
    const titleEl = $row
      .find('.tracklist_title .rendered_text, .tracklist_title, .song, .track_name')
      .first();
    const durEl = $row
      .find('.tracklist_duration, .track_duration, .duration')
      .first();
    const title = cleanText(titleEl.text());
    if (!title) {
      return;
    }
    const position = cleanText(numEl.text());
    const key = `${position}|${title}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    out.push({ position, title, duration: cleanText(durEl.text()) });
  });
  return out;
};

const splitListField = (text: string): string[] =>
  uniqueClean(text.split(/[,•/]/));

interface ReleaseInfo {
  primaryGenres: string[];
  secondaryGenres: string[];
  descriptors: string[];
  releaseType: string;
  date: string;
  year: number | null;
  rating: number | null;
  nRatings: number | null;
}

const parseReleaseInfo = ($: CheerioAPI): ReleaseInfo => {
  const info: ReleaseInfo = {
    primaryGenres: [],
    secondaryGenres: [],
    descriptors: [],
    releaseType: 'album',
    date: '',
    year: null,
    rating: null,
    nRatings: null,
  };

  $('table.album_info tr').each((_, row) => {
    const $row = $(row);
    const key = cleanText($row.find('th').first().text()).toLowerCase();
    const td = $row.find('td').first();
    if (!key || !td.length) {
      return;
    }
    if (key.includes('primary') && key.includes('genre')) {
      info.primaryGenres = textsFromSelection($, td.find('a.genre'));
      if (info.primaryGenres.length === 0) {
        info.primaryGenres = splitListField(cleanText(td.text()));
      }
    } else if (key.includes('secondary') && key.includes('genre')) {
      info.secondaryGenres = textsFromSelection($, td.find('a.genre'));
      if (info.secondaryGenres.length === 0) {
        info.secondaryGenres = splitListField(cleanText(td.text()));
      }
    } else if (key.includes('genre') && info.primaryGenres.length === 0) {
      info.primaryGenres = textsFromSelection($, td.find('a.genre'));
      if (info.primaryGenres.length === 0) {
        info.primaryGenres = splitListField(cleanText(td.text()));
      }
    } else if (key.includes('descriptor')) {
      info.descriptors = splitListField(cleanText(td.text()));
    } else if (key.includes('type')) {
      info.releaseType = cleanText(td.text()).toLowerCase().split(' ')[0] ?? 'album';
    } else if (key.includes('released') || key.includes('release date')) {
      info.date = cleanText(td.text());
      info.year = parseYear(info.date);
    }
  });

  const avg = $('.avg_rating').first();
  if (avg.length > 0) {
    info.rating = parseRating(avg.text());
  }
  const num = $('.num_ratings').first();
  if (num.length > 0) {
    info.nRatings = parseCount(num.text());
  }
  return info;
};

export const parseReleasePage = (html: string, rymId: string): RymRelease => {
  const $ = load(html);

  const titleEl = $('.album_title').first();
  let artist = '';
  let artistId = '';
  let title = '';
  if (titleEl.length > 0) {
    const artistAnchor = titleEl.find('a.artist').first();
    if (artistAnchor.length > 0) {
      artist = cleanText(artistAnchor.text());
      artistId = artistSlugFromUrl(abs(artistAnchor.attr('href')));
    }
    const rawTitle = cleanText(titleEl.text());
    const split = rawTitle.split(/\bBy\b/);
    title = split[0] !== undefined ? split[0].trim() : '';
  }
  if (!artist) {
    const a = $('.album_info a.artist, a.artist').first();
    if (a.length > 0) {
      artist = cleanText(a.text());
      artistId = artistSlugFromUrl(abs(a.attr('href')));
    }
  }

  const info = parseReleaseInfo($);
  const tracklist = parseTracklist($);
  const coverImg = $('img.coverart_img, .page_release_art_frame img, #coverart_img').first();

  return {
    rymId,
    title,
    artist,
    artistId,
    url: `https://rateyourmusic.com/release/${info.releaseType}/${rymId}/`,
    releaseType: info.releaseType,
    year: info.year,
    date: info.date,
    rating: info.rating,
    nRatings: info.nRatings,
    nReviews: null,
    primaryGenres: info.primaryGenres,
    secondaryGenres: info.secondaryGenres,
    descriptors: info.descriptors,
    tracklist,
    coverUrl: abs(coverImg.attr('src')),
    position: null,
  };
};
