import type { UserInfoResponseLfm } from '@lastfm/models/userInfoLfm';
import type { LastFmUser } from '@domain/models/lastFmUser';
import { TrackConverter } from './recentTrackConverter';

export class UserConverter {
  public static convertUserInfo(response: UserInfoResponseLfm): LastFmUser {
    const user = response.user;
    let imageUrl = TrackConverter.pickLargestImage(user.image);
    if (imageUrl) {
      imageUrl = imageUrl.replace('/u/300x300/', '/u/');
    }
    return {
      name: user.name,
      realName: user.realname || undefined,
      playCount: Number(user.playcount),
      registeredAt: user.registered?.unixtime
        ? new Date(Number(user.registered.unixtime) * 1000)
        : undefined,
      country: user.country && user.country !== 'None' ? user.country : undefined,
      imageUrl,
      artistCount: user.artist_count ? Number(user.artist_count) : undefined,
      albumCount: user.album_count ? Number(user.album_count) : undefined,
      trackCount: user.track_count ? Number(user.track_count) : undefined,
    };
  }
}
