// Palettes, group metadata and HTTP-method colours shared by the canvas and the panels.

/** Group metadata (labels, icons, which lane and ELK band they belong to). */
export const GROUPS = {
  // Laravel roles
  'be:controller': { label: 'Controllers', icon: 'controller' },
  'be:routes': { label: 'Route files', icon: 'routes' },
  'be:middleware': { label: 'Middleware', icon: 'middleware' },
  'be:request': { label: 'Form requests', icon: 'request' },
  'be:resource': { label: 'API resources', icon: 'resource' },
  'be:policy': { label: 'Policies', icon: 'policy' },
  'be:service': { label: 'Services', icon: 'service' },
  'be:repository': { label: 'Repositories', icon: 'repository' },
  'be:job': { label: 'Jobs', icon: 'job' },
  'be:event': { label: 'Events', icon: 'event' },
  'be:listener': { label: 'Listeners', icon: 'listener' },
  'be:provider': { label: 'Providers', icon: 'provider' },
  'be:other': { label: 'Other PHP', icon: 'php' },
  'be:model': { label: 'Models', icon: 'model' },
  // Endpoints
  'ep:laravel': { label: 'Laravel routes', icon: 'endpoint' },
  'ep:next': { label: 'Next.js handlers', icon: 'lambda' },
  'ep:unmatched': { label: 'Unmatched calls', icon: 'alert' },
  // Next.js
  'fe:page': { label: 'Pages', icon: 'page' },
  'fe:layout': { label: 'Layouts & special', icon: 'layout' },
  'fe:route': { label: 'Route handler files', icon: 'lambda' },
  'fe:component': { label: 'Components', icon: 'component' },
  'fe:hook': { label: 'Hooks', icon: 'hook' },
  'fe:lib': { label: 'Lib / API clients', icon: 'lib' },
  'fe:other': { label: 'Other JS/TS', icon: 'js' },
};
export const GROUP_ORDER = Object.keys(GROUPS);

/** Lane of a group key ('be' | 'ep' | 'fe'). */
export const laneOf = (g) => g.slice(0, 2);

export const LANES = {
  be: { title: 'Laravel', sub: 'backend' },
  ep: { title: 'Endpoints', sub: 'HTTP routes' },
  fe: { title: 'Next.js', sub: 'frontend' },
};

/**
 * ELK partition (with direction LEFT, partition 0 is the rightmost band). Each band
 * becomes one column of cards, so roles line up: models far left, controllers next
 * to the endpoints, API clients next to them on the right, pages far right.
 */
export const BAND = {
  'fe:page': 0,
  'fe:layout': 0,
  'fe:component': 1,
  'fe:route': 1,
  'fe:hook': 2,
  'fe:lib': 2,
  'fe:other': 2,
  'ep:laravel': 3,
  'ep:next': 3,
  'ep:unmatched': 3,
  'be:controller': 4,
  'be:routes': 4,
  'be:middleware': 4,
  'be:request': 5,
  'be:resource': 5,
  'be:policy': 5,
  'be:service': 5,
  'be:repository': 5,
  'be:job': 5,
  'be:event': 5,
  'be:listener': 5,
  'be:provider': 5,
  'be:other': 5,
  'be:model': 6,
};

const dark = {
  name: 'dark',
  canvas: '#0e1015',
  grid: 'rgba(233, 235, 241, 0.075)',
  card: '#1b1e28',
  cardBorder: '#2c3140',
  cardHover: '#3d4459',
  compound: '#14171f',
  text: '#e9ebf1',
  muted: '#9097a9',
  faint: '#5f667a',
  accent: '#f2b54a',
  select: '#f2b54a',
  lanes: { be: '#ff5d4a', ep: '#f2b54a', fe: '#7aa7ff' },
  laneAlpha: 0.055,
  edges: { imports: '#4d5468', uses: '#4d5468', calls: '#6f9dff', renders: '#b48cff', http: '#f2b54a', handles: '#ff6a55' },
  methods: { GET: '#3ecf8e', HEAD: '#3ecf8e', POST: '#6f9dff', PUT: '#f2b54a', PATCH: '#f2b54a', DELETE: '#ff6a55', ANY: '#b48cff', OPTIONS: '#b48cff', '?': '#9097a9' },
  // Security lens. No green: a restriction being declared is not the same as "safe".
  security: { authorization: '#a08bff', authenticated: '#5aa9ff', signed: '#3fc7c0', public: '#a7aec0', unknown: '#f2b54a', none: '#ff6a55' },
  groups: {
    'be:controller': '#ff6a55',
    'be:routes': '#ff5d4a',
    'be:middleware': '#c38bff',
    'be:request': '#f5a65b',
    'be:resource': '#3fd0b0',
    'be:policy': '#e58ad6',
    'be:service': '#4cd18a',
    'be:repository': '#43c4e8',
    'be:job': '#ff7fb5',
    'be:event': '#ff7fb5',
    'be:listener': '#ff7fb5',
    'be:provider': '#9aa3b8',
    'be:other': '#8d94a7',
    'be:model': '#6ea8ff',
    'ep:laravel': '#ff5d4a',
    'ep:next': '#e9ebf1',
    'ep:unmatched': '#f2b54a',
    'fe:page': '#7aa7ff',
    'fe:layout': '#a3b4d6',
    'fe:route': '#9d8cff',
    'fe:component': '#4fd1e8',
    'fe:hook': '#c38bff',
    'fe:lib': '#f2c94c',
    'fe:other': '#8d94a7',
  },
};

const light = {
  name: 'light',
  canvas: '#f3f1ea',
  grid: 'rgba(28, 30, 38, 0.09)',
  card: '#ffffff',
  cardBorder: '#ddd8cb',
  cardHover: '#b9b2a2',
  compound: '#faf8f3',
  text: '#1c1e26',
  muted: '#646a79',
  faint: '#a0a5b1',
  accent: '#c7851a',
  select: '#c7851a',
  lanes: { be: '#e0442f', ep: '#c7851a', fe: '#2f6fde' },
  laneAlpha: 0.06,
  edges: { imports: '#bdb7a8', uses: '#bdb7a8', calls: '#2f6fde', renders: '#8a4fd8', http: '#d08a12', handles: '#e0442f' },
  methods: { GET: '#13915f', HEAD: '#13915f', POST: '#2f6fde', PUT: '#c7851a', PATCH: '#c7851a', DELETE: '#e0442f', ANY: '#8a4fd8', OPTIONS: '#8a4fd8', '?': '#646a79' },
  security: { authorization: '#6a4fd8', authenticated: '#2f6fde', signed: '#0f8f89', public: '#6b7385', unknown: '#c7851a', none: '#e0442f' },
  groups: {
    'be:controller': '#e0442f',
    'be:routes': '#e0442f',
    'be:middleware': '#8a4fd8',
    'be:request': '#c9741d',
    'be:resource': '#13917a',
    'be:policy': '#a2479a',
    'be:service': '#1e9e5a',
    'be:repository': '#1b8fb8',
    'be:job': '#c93f7f',
    'be:event': '#c93f7f',
    'be:listener': '#c93f7f',
    'be:provider': '#5d6b82',
    'be:other': '#7d8494',
    'be:model': '#2f6fde',
    'ep:laravel': '#e0442f',
    'ep:next': '#1c1e26',
    'ep:unmatched': '#c7851a',
    'fe:page': '#2f6fde',
    'fe:layout': '#4f6b9a',
    'fe:route': '#6a4fd8',
    'fe:component': '#0d8bb5',
    'fe:hook': '#8a4fd8',
    'fe:lib': '#a57c00',
    'fe:other': '#7d8494',
  },
};

export const THEMES = { dark, light };

/** Security lens states, strongest first (labels avoid "secure" / "safe" on purpose). */
export const SEC_STATES = [
  ['authorization', 'Authorization check seen', 'A gate, policy, can: middleware, authorizeResource, FormRequest authorize() or an authorize call; in Next.js, a role or permission test that denies the request. Its logic was not evaluated.'],
  ['authenticated', 'Authenticated', 'Authentication middleware applies (auth, auth.basic, verified, or one you configured); in Next.js, code that denies the request without a signed-in user or a shared secret.'],
  ['signed', 'Signed URL', 'The signed middleware requires a valid URL signature.'],
  ['public', 'Public (guest)', 'Explicitly meant for anonymous users: guest middleware.'],
  ['unknown', 'Unknown', 'Something that could change the answer was not resolved: custom or unresolved middleware, closures, a missing handler, a session read whose effect was not evaluated.'],
  ['none', 'No protection found', 'Everything that applies was resolved and none of it restricts access. Not necessarily wrong: review it.'],
];
export const SEC_LABEL = Object.fromEntries(SEC_STATES.map(([k, l]) => [k, l]));

/** First method of an endpoint ("PATCH|PUT" -> "PATCH"). */
export const primaryMethod = (method) => (method || '?').split('|')[0];

/** Short badge text: GET, POST, PATCH+1 ... */
export function methodBadge(method) {
  const parts = (method || '?').split('|');
  return parts.length > 1 ? `${parts[0]}+${parts.length - 1}` : parts[0];
}

export const methodColor = (theme, method) => theme.methods[primaryMethod(method)] ?? theme.methods['?'];
