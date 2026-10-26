const READER_ORIGINS = ['https://www.qireader.com', 'https://www.qireader.com.cn'];

function webURL(value) {
  if (typeof value !== 'string' || value.length > 16384) return null;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

function readerURL(value) {
  const url = webURL(value);
  return Boolean(url && READER_ORIGINS.includes(new URL(url).origin));
}

module.exports = { READER_ORIGINS, webURL, readerURL };
