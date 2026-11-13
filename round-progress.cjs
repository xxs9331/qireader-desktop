const kinds = ['reading', 'saving'];
function validRounds(value) {
  return value === undefined || value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).every(kind => kinds.includes(kind)) && Object.values(value).every(round =>
      round && Number.isInteger(round.target) && round.target >= 1 && round.target <= 100 &&
      (round.basis === undefined || round.basis === 'opened') &&
      Array.isArray(round.ids) && round.ids.length <= 100 && round.ids.every(id => typeof id === 'string' && id.length > 0 && id.length <= 512));
}
function countRound(rounds, kind, id) {
  if (!kinds.includes(kind) || typeof id !== 'string' || !id || id.length > 512) throw Error('点灯记录无效');
  const round = rounds?.[kind] || { target: 10, ids: [] };
  if (round.ids.includes(id) || round.ids.length >= round.target) return rounds;
  return { ...rounds, [kind]: { ...round, ids: [...round.ids, id] } };
}
module.exports = { validRounds, countRound };
