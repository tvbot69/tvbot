import { injectable } from 'tsyringe';
import { prisma } from '@persistence/prismaClient';

export enum SearchTab {
  Tracks = 0,
  Albums = 1,
  Artists = 2,
  Plays = 3,
}

export interface SearchResultRow {
  primary: string;
  secondary?: string | null;
  count: number;
  rank?: number;
  timePlayed?: Date;
}

@injectable()
export class LibrarySearchService {
  public async search(
    userId: number,
    query: string,
    tab: SearchTab,
  ): Promise<SearchResultRow[]> {
    if (!query.trim() || userId <= 0) {
      return [];
    }

    const pattern = `%${query.trim()}%`;

    switch (tab) {
      case SearchTab.Artists: {
        const rows = await prisma.$queryRaw<Array<{ name: string; playcount: number; rank: number }>>`
          WITH ranked AS (
            SELECT name, playcount,
                   CAST(ROW_NUMBER() OVER (ORDER BY playcount DESC) AS int) AS rank
            FROM public.user_artists
            WHERE user_id = ${userId}
          )
          SELECT name, playcount, rank
          FROM ranked
          WHERE name ILIKE ${pattern}
          ORDER BY playcount DESC
          LIMIT 100
        `;
        return rows.map((r) => ({
          primary: r.name,
          count: Number(r.playcount),
          rank: Number(r.rank),
        }));
      }

      case SearchTab.Albums: {
        const rows = await prisma.$queryRaw<Array<{ name: string; artist_name: string; playcount: number; rank: number }>>`
          WITH ranked AS (
            SELECT ua.name, a.name AS artist_name, ua.playcount,
                   CAST(ROW_NUMBER() OVER (ORDER BY ua.playcount DESC) AS int) AS rank
            FROM public.user_albums ua
            JOIN public.albums ab ON ua.album_id = ab.album_id
            JOIN public.artists a ON ab.artist_id = a.artist_id
            WHERE ua.user_id = ${userId}
          )
          SELECT name, artist_name, playcount, rank
          FROM ranked
          WHERE (artist_name || ' ' || name) ILIKE ${pattern}
          ORDER BY playcount DESC
          LIMIT 100
        `;
        return rows.map((r) => ({
          primary: r.name,
          secondary: r.artist_name,
          count: Number(r.playcount),
          rank: Number(r.rank),
        }));
      }

      case SearchTab.Tracks: {
        const rows = await prisma.$queryRaw<Array<{ name: string; artist_name: string; playcount: number; rank: number }>>`
          WITH ranked AS (
            SELECT ut.name, a.name AS artist_name, ut.playcount,
                   CAST(ROW_NUMBER() OVER (ORDER BY ut.playcount DESC) AS int) AS rank
            FROM public.user_tracks ut
            JOIN public.tracks t ON ut.track_id = t.track_id
            JOIN public.artists a ON t.artist_id = a.artist_id
            WHERE ut.user_id = ${userId}
          )
          SELECT name, artist_name, playcount, rank
          FROM ranked
          WHERE (artist_name || ' ' || name) ILIKE ${pattern}
          ORDER BY playcount DESC
          LIMIT 100
        `;
        return rows.map((r) => ({
          primary: r.name,
          secondary: r.artist_name,
          count: Number(r.playcount),
          rank: Number(r.rank),
        }));
      }

      case SearchTab.Plays: {
        const rows = await prisma.$queryRaw<Array<{ track_name: string | null; album_name: string | null; artist_name: string; time_played: Date }>>`
          SELECT track_name, album_name, artist_name, time_played
          FROM public.user_plays
          WHERE user_id = ${userId}
            AND (artist_name || ' ' || COALESCE(album_name, '') || ' ' || COALESCE(track_name, '')) ILIKE ${pattern}
          ORDER BY time_played DESC
          LIMIT 60
        `;
        return rows.map((r) => ({
          primary: r.track_name ?? 'Unknown Track',
          secondary: r.artist_name,
          count: 1,
          timePlayed: new Date(r.time_played),
        }));
      }

      default:
        return [];
    }
  }
}
