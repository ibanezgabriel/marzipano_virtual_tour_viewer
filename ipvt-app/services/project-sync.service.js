/* Synchronizes project changes into persistent storage. */
const { syncProjectByToken, syncProjectByTokenWithPrevious } = require('../db/project-sync');

/* Updates sync project to database or throw. */
async function syncProjectToDatabaseOrThrow(projectToken, actorUserId, opts = {}) {
  const previousProjectToken = opts && opts.previousProjectToken ? String(opts.previousProjectToken).trim() : '';
  const previousProjectNumber = opts && opts.previousProjectNumber ? String(opts.previousProjectNumber).trim() : '';
  if (previousProjectToken || previousProjectNumber) {
    return syncProjectByTokenWithPrevious(projectToken, {
      createdByUserId: actorUserId,
      previousProjectToken,
      previousProjectNumber,
    });
  }
  return syncProjectByToken(projectToken, { createdByUserId: actorUserId });
}

module.exports = {
  syncProjectToDatabaseOrThrow,
};
