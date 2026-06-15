// caldav.js — creates VTODO items on NextCloud via CalDAV PUT
export async function createTodo({ url, username, password }, summary) {
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

  const targetUrl = `${url.replace(/\/$/, '')}/${uid}.ics`;

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

export async function testConnection({ url, username, password }) {
  const response = await fetch(url.replace(/\/$/, ''), {
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
