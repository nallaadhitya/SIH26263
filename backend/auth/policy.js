const ROLES = Object.freeze([
  'institution_admin', 'institution_operator', 'regulatory_reviewer', 'authorized_verifier',
]);
const INSTITUTION_ROLES = Object.freeze(['institution_admin', 'institution_operator']);

// Student capabilities are explicitly scoped. Unrestricted student:read stays denied.
const PERMISSIONS = Object.freeze({
  institution_admin: ['institution:read', 'institution:manage', 'student:read:own', 'student:write:own', 'student:import:own', 'compliance:read:own', 'compliance:evaluate:own', 'ml:evaluate:own', 'verification:issue:own', 'verification:revoke:own'],
  institution_operator: ['institution:read', 'student:read:own', 'student:write:own', 'student:import:own', 'compliance:read:own', 'compliance:evaluate:own', 'ml:evaluate:own', 'verification:issue:own', 'verification:revoke:own'],
  regulatory_reviewer: ['regulatory:summary'],
  authorized_verifier: ['verification:request'],
});

function validAccount(user) {
  return user && user.status === 'active' && ROLES.includes(user.role)
    && typeof user.id === 'string'
    && (!INSTITUTION_ROLES.includes(user.role)
      || (typeof user.institutionId === 'string' && user.institutionId.length > 0));
}

function publicUser(user) {
  return {
    id: user.id, displayName: user.displayName, email: user.email,
    role: user.role, institutionId: user.institutionId || null, status: user.status,
  };
}

function hasPermission(user, permission) {
  return Boolean(user && PERMISSIONS[user.role]?.includes(permission));
}

class AccessError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// A request can spend time waiting for a JSON write queue. Recheck the current
// account at the mutation boundary rather than relying on an earlier role copy.
async function assertCurrentAccess(store, user, permission) {
  const accounts = await store.readCollection('users', { initialize: false });
  const current = accounts.find(account => account?.id === user.id);
  if (!validAccount(current)) throw new AccessError(401, 'Authentication required');
  if (!hasPermission(current, permission) || !canAccessInstitution(current, user.institutionId)) {
    throw new AccessError(403, 'Access denied');
  }
  const institutions = await store.readCollection('institutions', { initialize: false });
  if (!institutions.some(institution => institution?.id === current.institutionId)) {
    throw new AccessError(401, 'Authentication required');
  }
}

function requirePermission(permission) {
  return (request, response, next) => {
    if (!request.user) return response.status(401).json({ error: 'Authentication required' });
    if (!hasPermission(request.user, permission)) {
      return response.status(403).json({ error: 'Access denied' });
    }
    return next();
  };
}

function canAccessInstitution(user, institutionId) {
  return Boolean(user && INSTITUTION_ROLES.includes(user.role)
    && typeof institutionId === 'string' && institutionId.length > 0
    && user.institutionId === institutionId);
}

// Use the persisted resource's institution ID for record routes. Never trust a body
// or query parameter to declare ownership. Reviewers/verifiers do not bypass scope.
function requireInstitution(resolveInstitutionId = (request) => request.params.institutionId) {
  return (request, response, next) => {
    if (!request.user) return response.status(401).json({ error: 'Authentication required' });
    const institutionId = resolveInstitutionId(request);
    if (!canAccessInstitution(request.user, institutionId)) {
      return response.status(403).json({ error: 'Access denied' });
    }
    return next();
  };
}

module.exports = { ROLES, INSTITUTION_ROLES, validAccount, publicUser, hasPermission, requirePermission, assertCurrentAccess, AccessError,
  requireInstitution, canAccessInstitution };
