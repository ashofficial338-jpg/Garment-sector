import axios from 'axios';

/**
 * API client. The access token lives only in memory; the refresh token is an
 * httpOnly cookie, so nothing sensitive is stored in localStorage.
 */
export const api = axios.create({ baseURL: '/api', withCredentials: true });

let accessToken = null;
let refreshing = null;
const listeners = new Set();

export const setAccessToken = (t) => { accessToken = t; };
export const onAuthChange = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
const emit = (evt) => listeners.forEach((fn) => fn(evt));

api.interceptors.request.use((cfg) => {
  if (accessToken) cfg.headers.Authorization = `Bearer ${accessToken}`;
  return cfg;
});

// The backend (free Render instance) can drop connections while waking up; retry those
// instead of treating them as "logged out". A real 401 is not retried.
const transient = (e) => !e.response || [502, 503, 504].includes(e.response.status);
async function postRefresh(attempt = 0) {
  try {
    return await axios.post('/api/auth/refresh', {}, { withCredentials: true });
  } catch (e) {
    if (attempt >= 3 || !transient(e)) throw e;
    await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    return postRefresh(attempt + 1);
  }
}

export async function refreshSession() {
  if (!refreshing) {
    refreshing = postRefresh()
      .then((r) => { accessToken = r.data.accessToken; emit({ type: 'refreshed', user: r.data.user }); return r.data; })
      .finally(() => { refreshing = null; });
  }
  return refreshing;
}

api.interceptors.response.use(
  (r) => r,
  async (err) => {
    const { config, response } = err;
    if (response?.status === 401 && !config._retry && !config.url.startsWith('/auth/')) {
      config._retry = true;
      try {
        await refreshSession();
        return api(config);
      } catch {
        emit({ type: 'logout' });
      }
    }
    if (response?.status === 403 && response.data?.details?.code === 'PASSWORD_CHANGE_REQUIRED') emit({ type: 'password' });
    if (response?.status === 403 && response.data?.details?.code === 'UNIT_REQUIRED') emit({ type: 'unit' });
    return Promise.reject(err);
  },
);

/** Human readable error message from an axios error. */
export function errMsg(e) {
  const d = e?.response?.data;
  if (d?.details && typeof d.details === 'object' && !d.details.code) {
    const first = Object.values(d.details).filter((v) => typeof v === 'string');
    if (first.length) return `${d.message}: ${first.slice(0, 3).join('; ')}`;
  }
  return d?.message || e?.message || 'Something went wrong';
}
export const needsOverride = (e) => e?.response?.data?.details?.code === 'OVERRIDE_REQUIRED';

/** Download a file from an authenticated endpoint. */
export async function download(url, params, fallbackName) {
  const res = await api.get(url, { params, responseType: 'blob' });
  const cd = res.headers['content-disposition'] || '';
  const name = decodeURIComponent((cd.match(/filename="?([^"]+)"?/) || [])[1] || fallbackName || 'download');
  const href = URL.createObjectURL(res.data);
  const a = document.createElement('a');
  a.href = href; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(href), 2000);
}

/** Open an authenticated file (preview) in a new tab. */
export async function openFile(url, params) {
  const res = await api.get(url, { params, responseType: 'blob' });
  const href = URL.createObjectURL(res.data);
  window.open(href, '_blank', 'noopener');
  setTimeout(() => URL.revokeObjectURL(href), 60000);
}
