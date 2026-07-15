import houseOfDragonS01E05 from './houseOfDragonS01E05';
import houseOfDragonS03E01 from './houseOfDragonS03E01';

const EPISODES = {
  [houseOfDragonS01E05.videoId]: houseOfDragonS01E05,
  [houseOfDragonS03E01.videoId]: houseOfDragonS03E01,
};

const DEFAULT_CONFIG = {
  videoId: null,
  episodeTag: 'EP',
  railLabel: 'EP',
  quickQuestions: ['这个角色是谁', '解释这个镜头', '这句台词什么意思'],
};

export function getEpisodeConfig(videoId) {
  return EPISODES[videoId] || { ...DEFAULT_CONFIG, videoId: videoId || null };
}

export default EPISODES;
