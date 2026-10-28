class RegulatoryError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function safeRows(value) { return Array.isArray(value) ? value : []; }

class RegulatoryService {
  constructor({ store }) { this.store = store; }

  async summary() {
    const [institutions, programmes, intakes, students] = await Promise.all([
      this.store.readCollection('institutions', { initialize: false }),
      this.store.readCollection('programmes', { initialize: false }),
      this.store.readCollection('approved-intakes', { initialize: false }),
      this.store.readCollection('students', { initialize: false }),
    ]);
    const safeInstitutions = safeRows(institutions).filter(row => typeof row?.id === 'string');
    const safeStudents = safeRows(students).filter(row => typeof row?.institutionId === 'string');
    const summary = safeInstitutions.map(institution => {
      const scoped = safeStudents.filter(student => student.institutionId === institution.id);
      const active = scoped.filter(student => student.status === 'active').length;
      const configuredIntakes = safeRows(intakes).filter(row => row?.institutionId === institution.id);
      const approvedSeats = configuredIntakes.reduce((total, row) => total + (Number.isSafeInteger(row.approvedSeats) && row.approvedSeats >= 0 ? row.approvedSeats : 0), 0);
      return { institutionId: institution.id, institutionName: typeof institution.name === 'string' ? institution.name : institution.id,
        programmeCount: safeRows(programmes).filter(programme => programme?.institutionId === institution.id).length,
        studentRecords: scoped.length, activeEnrolment: active, approvedSeats, intakeRows: configuredIntakes.length };
    });
    const activeKeys = new Map();
    for (const student of safeStudents) {
      if (student.status !== 'active' || typeof student.apaarId !== 'string' || !student.apaarId) continue;
      const institutionsForId = activeKeys.get(student.apaarId) || new Set(); institutionsForId.add(student.institutionId); activeKeys.set(student.apaarId, institutionsForId);
    }
    const potentialCrossInstitutionConflicts = [...activeKeys.values()].filter(set => set.size > 1).length;
    return { generatedAt: new Date().toISOString(), scope: 'de_identified_institution_aggregates',
      totals: { institutions: summary.length, studentRecords: safeStudents.length, activeEnrolment: safeStudents.filter(student => student.status === 'active').length, potentialCrossInstitutionConflicts }, institutions: summary };
  }
}

module.exports = { RegulatoryService, RegulatoryError };
