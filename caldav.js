// caldav.js — creates VTODO items on NextCloud via CalDAV PUT
export async function createTodo({ username, password }, listUrl, summary) {
  const uid      = `${Date.now()}-${Math.random().toString(36).slice(2)}@stt-notes`;
  const dtstamp  = toICalDate(new Date());

  const vcal = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//stt-notes//PWA//EN',
    'BEGIN:VTODO',
    `UID:${uid}`,
    `DTSTAMP:${dtstamp}`,
    `CREATED:${dtstamp}`,
    foldLine(`SUMMARY:${escapeIcal(summary.trim())}`),
    'STATUS:NEEDS-ACTION',
    'END:VTODO',
    'END:VCALENDAR',
  ].join('\r\n');

  const targetUrl = `${listUrl.replace(/\/$/, '')}/${uid}.ics`;

  const response = await fetch(targetUrl, {
    method: 'PUT',
    headers: {
      'Content-Type':  'text/calendar; charset=utf-8',
      'Authorization': 'Basic ' + btoa(`${username}:${password}`),
    },
    body: vcal,
  });

  return { ok: response.ok, status: response.status, statusText: response.statusText };
}

// Discover all task lists (calendar collections that support VTODO) under the
// account's calendar home, derived from the configured URL.
export async function discoverTaskLists({ url, username, password }) {
  const home = calendarHome(url);
  const response = await fetch(home, {
    method: 'PROPFIND',
    headers: {
      'Authorization': 'Basic ' + btoa(`${username}:${password}`),
      'Content-Type':  'application/xml; charset=utf-8',
      'Depth':         '1',
    },
    body:
      '<?xml version="1.0" encoding="utf-8"?>' +
      '<d:propfind xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav">' +
      '<d:prop><d:displayname/><d:resourcetype/>' +
      '<cal:supported-calendar-component-set/></d:prop></d:propfind>',
  });

  if (!(response.ok || response.status === 207)) {
    const err = new Error(`${response.status} ${response.statusText}`);
    err.status = response.status;
    throw err;
  }

  const DAV = 'DAV:';
  const CAL = 'urn:ietf:params:xml:ns:caldav';
  const xml = new DOMParser().parseFromString(await response.text(), 'application/xml');

  const lists = [];
  for (const r of xml.getElementsByTagNameNS(DAV, 'response')) {
    const href = r.getElementsByTagNameNS(DAV, 'href')[0]?.textContent?.trim();
    if (!href) continue;
    const isCalendar  = r.getElementsByTagNameNS(CAL, 'calendar').length > 0;
    const supportsTodo = [...r.getElementsByTagNameNS(CAL, 'comp')]
      .some(c => c.getAttribute('name') === 'VTODO');
    if (!isCalendar || !supportsTodo) continue;
    const name = r.getElementsByTagNameNS(DAV, 'displayname')[0]?.textContent?.trim() || href;
    lists.push({ href: new URL(href, url).href, name });
  }
  return lists;
}

// Strip a configured URL back to the calendar home: .../calendars/<user>/
function calendarHome(url) {
  const m = url.match(/^(.*\/calendars\/[^/]+\/)/);
  return m ? m[1] : url.replace(/\/$/, '') + '/';
}

export async function testConnection({ url, username, password }) {
  // Keep the trailing slash — NextCloud's DAV collections are canonical with it.
  const target = url.endsWith('/') ? url : url + '/';
  const response = await fetch(target, {
    method: 'PROPFIND',
    headers: {
      'Authorization': 'Basic ' + btoa(`${username}:${password}`),
      'Content-Type':  'application/xml',
      'Depth':         '0',
    },
    body: '<?xml version="1.0" encoding="utf-8"?><D:propfind xmlns:D="DAV:"><D:prop><D:resourcetype/></D:prop></D:propfind>',
  });
  return { ok: response.ok || response.status === 207, status: response.status, statusText: response.statusText };
}

function toICalDate(d) {
  return d.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
}

function escapeIcal(str) {
  return str
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\n/g, '\\n');
}

// RFC 5545 §3.1: fold lines longer than 75 octets
function foldLine(line) {
  if (line.length <= 75) return line;
  const parts = [];
  let pos = 0;
  while (pos < line.length) {
    const limit = parts.length === 0 ? 75 : 74;
    parts.push(line.slice(pos, pos + limit));
    pos += limit;
  }
  return parts.join('\r\n ');
}
