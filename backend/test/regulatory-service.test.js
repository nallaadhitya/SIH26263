const { RegulatoryService } = require('../regulatory/service');

test('regulatory summary is de-identified and marks only aggregate cross-institution conflicts', async () => {
  const collections = {
    institutions: [{ id: 'DEMO-INST-001', name: 'First' }, { id: 'DEMO-INST-002', name: 'Second' }],
    programmes: [{ institutionId: 'DEMO-INST-001' }],
    'approved-intakes': [{ institutionId: 'DEMO-INST-001', approvedSeats: 60 }],
    students: [{ institutionId: 'DEMO-INST-001', apaarId: '000000000001', status: 'active', studentName: 'Never disclosed' }, { institutionId: 'DEMO-INST-002', apaarId: '000000000001', status: 'active' }],
  };
  const result = await new RegulatoryService({ store: { readCollection: async name => collections[name] } }).summary();
  expect(result.totals).toEqual({ institutions: 2, studentRecords: 2, activeEnrolment: 2, potentialCrossInstitutionConflicts: 1 });
  expect(JSON.stringify(result)).not.toContain('000000000001');
  expect(JSON.stringify(result)).not.toContain('Never disclosed');
});
