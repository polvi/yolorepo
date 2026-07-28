// Reserved path namespace on every site origin. Site files under this prefix
// are never served.
export const NS_PREFIX = '/__forkable__';

export const NS_WIDGET = `${NS_PREFIX}/widget.js`;
export const NS_SW = `${NS_PREFIX}/sw.js`;
export const NS_API = `${NS_PREFIX}/api`;
export const NS_GIT = `${NS_PREFIX}/git`;
export const NS_TPX = `${NS_PREFIX}/tpx`;

// Trusted headers the front worker strips from inbound requests and re-sets
// before forwarding git requests to a RepoDO.
export const HDR_USER = 'X-Fk-User';
export const HDR_OWNER = 'X-Fk-Owner';
