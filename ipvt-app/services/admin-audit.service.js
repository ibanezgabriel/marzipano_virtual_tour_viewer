/* Emits targeted administrative audit logs for PM2 capture. */

const AUDIT_PREFIX = '[AUDIT]';
const PH_TIME_ZONE = 'Asia/Manila';

function formatPhilippinesTimestamp(date = new Date()) {
  // en-GB yields day/month/year ordering; force 24-hour clock for sorting.
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: PH_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date);

  const lookup = Object.create(null);
  parts.forEach((part) => {
    if (part.type !== 'literal') lookup[part.type] = part.value;
  });

  return `${lookup.day}/${lookup.month}/${lookup.year} ${lookup.hour}:${lookup.minute}:${lookup.second}`;
}

function formatAuditValue(value, fallback = '-') {
  const trimmed = String(value || '').trim();
  return trimmed ? trimmed : fallback;
}

function logAuditEvent({ actor, action, target }) {
  const timestamp = formatPhilippinesTimestamp();
  const actorValue = formatAuditValue(actor, 'Unknown');
  const actionValue = formatAuditValue(action, 'UNKNOWN');
  const targetValue = formatAuditValue(target, '-');

  console.log(
    `${AUDIT_PREFIX} [${timestamp}] | ACTOR: [${actorValue}] | ACTION: [${actionValue}] | TARGET: [${targetValue}]`
  );
}

module.exports = {
  logAuditEvent,
};
