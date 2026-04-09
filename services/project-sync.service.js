const { syncProjectByToken } = require('../db/project-sync');

async function syncProjectToDatabaseOrThrow(projectToken, actorUserId) {
  return syncProjectByToken(projectToken, { createdByUserId: actorUserId });
}

module.exports = {
  syncProjectToDatabaseOrThrow,
};
