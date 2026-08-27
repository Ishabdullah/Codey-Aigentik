import { jest } from '@jest/globals';
import {
  TRADES,
  TRADE_DISPLAY_NAMES,
  TRADE_SPECIFIC_QUESTIONS,
  normalizeTrade,
  extractAllTrades,
  getTradeDisplayName,
  getTradeSpecificQuestions,
  isRecognizedTrade,
  getAllTradeSlugs
} from '../trades.js';

import {
  QUALIFICATION_STATUSES,
  RECRUITMENT_STEPS,
  RECRUITER_FAQS,
  RECRUITER_OBJECTIONS,
  OPENING_SCRIPT,
  FOLLOW_UP_TEMPLATES,
  mapCoreToJS,
  mapJSToCore,
  loadSubcontractors,
  getSubcontractorById,
  findSubcontractor,
  createOrUpdateSubcontractorLead,
  updateSubcontractor,
  getMissingDocuments,
  determineQualificationStatus,
  determineNextRecruitmentStep,
  buildRecruiterSystemPrompt,
  formatSubcontractorSummary,
  formatPipelineReport,
  formatFollowupList
} from '../subcontractor-recruiter.js';

describe('Trades Taxonomy & Helpers', () => {
  it('normalizes common trade names and synonyms', () => {
    expect(normalizeTrade('General Contractor')).toBe('general_remodeling');
    expect(normalizeTrade('residential roofer')).toBe('roofing');
    expect(normalizeTrade('vinyl siding installer')).toBe('siding');
    expect(normalizeTrade('gutter cleaning and seamless gutters')).toBe('gutters');
    expect(normalizeTrade('interior painter')).toBe('painting');
    expect(normalizeTrade('master electrician')).toBe('electrical');
    expect(normalizeTrade('licensed plumber')).toBe('plumbing');
    expect(normalizeTrade('hvac technician')).toBe('hvac');
    expect(normalizeTrade('emergency water damage restoration')).toBe('water_damage_restoration');
    expect(normalizeTrade('mold remediation specialist')).toBe('mold_remediation');
    expect(normalizeTrade('custom trim and finish carpenter')).toBe('finish_carpentry');
  });

  it('extracts all matching trades for multi-trade contractors', () => {
    const extracted = extractAllTrades('We do painting, drywall, and finish carpentry');
    expect(extracted).toContain('painting');
    expect(extracted).toContain('drywall');
    expect(extracted).toContain('finish_carpentry');
  });

  it('returns clean trade display names', () => {
    expect(getTradeDisplayName('roofing')).toBe('Roofing');
    expect(getTradeDisplayName('water_damage_restoration')).toBe('Water Damage Restoration');
    expect(getTradeDisplayName('hvac')).toBe('HVAC / Heating & Cooling');
  });

  it('provides tailored trade-specific qualification questions', () => {
    const roofingQuestions = getTradeSpecificQuestions('roofing');
    expect(roofingQuestions.length).toBeGreaterThan(0);
    expect(roofingQuestions.some(q => q.toLowerCase().includes('shingle') || q.toLowerCase().includes('tear-off'))).toBe(true);

    const electricalQuestions = getTradeSpecificQuestions('electrical');
    expect(electricalQuestions.some(q => q.includes('E-1') || q.includes('license') || q.includes('service'))).toBe(true);

    const waterQuestions = getTradeSpecificQuestions('water_damage_restoration');
    expect(waterQuestions.some(q => q.includes('IICRC') || q.includes('drying') || q.includes('extraction'))).toBe(true);
  });
});

describe('Subcontractor Recruiter Knowledge Base & Guardrails', () => {
  it('includes mandatory 2027 ramp-up positioning in opening script', () => {
    expect(OPENING_SCRIPT).toContain('January 2027 ramp-up');
    expect(OPENING_SCRIPT).toContain('Restoricon');
  });

  it('enforces safety guardrails in recruiter prompt', () => {
    const prompt = buildRecruiterSystemPrompt({
      company_name: 'Apex Builders',
      primary_trade: 'roofing',
      qualification_status: 'NEW_LEAD'
    });

    expect(prompt).toContain('January 2027');
    expect(prompt).toContain('PROHIBITED PHRASES');
    expect(prompt).toContain('NEVER guarantee work');
    expect(prompt).toContain('NEVER approve a contractor independently');
    expect(prompt).toContain('NEVER invent pricing');
  });

  it('provides approved standard answers to common subcontractor questions', () => {
    const workNowFaq = RECRUITER_FAQS.find(f => f.topic === 'work_right_now');
    expect(workNowFaq.answer).toContain('January 2027');

    const guaranteedFaq = RECRUITER_FAQS.find(f => f.topic === 'guaranteed_work');
    expect(guaranteedFaq.answer.toLowerCase()).toContain('does not guarantee');

    const ratesFaq = RECRUITER_FAQS.find(f => f.topic === 'pay_rates');
    expect(ratesFaq.answer).toContain('scope of work');
  });

  it('provides approved objection handling', () => {
    expect(RECRUITER_OBJECTIONS.already_busy).toContain('2027');
    expect(RECRUITER_OBJECTIONS.are_you_contractor).toContain('Restoricon');
    expect(RECRUITER_OBJECTIONS.how_got_number('Google Maps')).toContain('Google Maps');
  });
});

describe('Missing Documents Computation', () => {
  it('calculates all missing docs for a new lead', () => {
    const lead = {
      w9_received: false,
      msa_signed: false,
      coi_received: false,
      workers_comp: null,
      license_required: true,
      license_status: 'LICENSE_PENDING_VERIFICATION',
      references: []
    };

    const missing = getMissingDocuments(lead);
    expect(missing).toContain('W-9 (Taxpayer Identification Form)');
    expect(missing).toContain('Signed Master Subcontractor Agreement (MSA)');
    expect(missing).toContain('Certificate of Insurance (General Liability with Restoricon as Additional Insured)');
    expect(missing).toContain("Workers' Compensation Certificate or Applicable Exemption Verification");
    expect(missing).toContain('State Trade License / HIC Registration Copy or Number');
    expect(missing).toContain('Trade References / Project Portfolio');
  });

  it('returns empty missing list when all documentation is verified', () => {
    const complete = {
      w9_received: true,
      msa_signed: true,
      coi_received: true,
      workers_comp: true,
      license_required: true,
      license_status: 'LICENSE_VERIFIED',
      references: ['Reference 1', 'Reference 2']
    };

    const missing = getMissingDocuments(complete);
    expect(missing).toHaveLength(0);
  });
});

describe('Qualification Status & Progression Logic', () => {
  it('NEVER auto-promotes to APPROVED_ONBOARDING without explicit human owner approval', () => {
    const fullyDocumented = {
      w9_received: true,
      msa_signed: true,
      coi_received: true,
      workers_comp: true,
      license_status: 'LICENSE_VERIFIED',
      qualification_status: QUALIFICATION_STATUSES.DOCUMENTS_UNDER_REVIEW
    };

    const calculated = determineQualificationStatus(fullyDocumented);
    expect(calculated).toBe(QUALIFICATION_STATUSES.DOCUMENTS_UNDER_REVIEW);
    expect(calculated).not.toBe(QUALIFICATION_STATUSES.APPROVED_ONBOARDING);
    expect(calculated).not.toBe(QUALIFICATION_STATUSES.ONBOARDING_COMPLETE);
  });

  it('determines next recruitment steps systematically', () => {
    expect(determineNextRecruitmentStep(null)).toBe(RECRUITMENT_STEPS.OPENING);

    const stepCompany = determineNextRecruitmentStep({
      qualification_data: { permission_granted: true }
    });
    expect(stepCompany).toBe(RECRUITMENT_STEPS.COMPANY_INFO);

    const stepTrade = determineNextRecruitmentStep({
      company_name: 'CT Pro Painting',
      qualification_data: { permission_granted: true }
    });
    expect(stepTrade).toBe(RECRUITMENT_STEPS.TRADE_QUALIFICATION);

    const stepTradeSpecific = determineNextRecruitmentStep({
      company_name: 'CT Pro Painting',
      primary_trade: 'painting',
      qualification_data: { permission_granted: true }
    });
    expect(stepTradeSpecific).toBe(RECRUITMENT_STEPS.TRADE_SPECIFIC);
  });
});

describe('Reporting & Summaries', () => {
  it('formats detailed profile summary', () => {
    const summary = formatSubcontractorSummary({
      subcontractor_id: 'sub_0001',
      company_name: 'Elite Roofing LLC',
      contact_name: 'John Doe',
      primary_trade: 'roofing',
      crew_size: 4,
      years_in_business: 10,
      license_number: 'HIC.0654321',
      qualification_status: QUALIFICATION_STATUSES.QUALIFIED_PENDING_DOCUMENTS
    });

    expect(summary).toContain('sub_0001');
    expect(summary).toContain('Elite Roofing LLC');
    expect(summary).toContain('Roofing');
    expect(summary).toContain('QUALIFIED_PENDING_DOCUMENTS');
  });

  it('formats pipeline report for empty and active states', async () => {
    const reportEmpty = await formatPipelineReport([]);
    expect(typeof reportEmpty).toBe('string');
    expect(reportEmpty).toContain('No subcontractors currently');

    const reportActive = await formatPipelineReport([
      {
        subcontractor_id: 'sub_0001',
        company_name: 'Apex Builders',
        primary_trade: 'roofing',
        qualification_status: QUALIFICATION_STATUSES.QUALIFIED_PENDING_DOCUMENTS
      }
    ]);
    expect(reportActive).toContain('Apex Builders');
    expect(reportActive).toContain('Total Subcontractors: 1');
  });

  it('formats follow-up list for empty and active states', async () => {
    const followEmpty = await formatFollowupList([]);
    expect(followEmpty).toContain('No pending subcontractor follow-ups');

    const followActive = await formatFollowupList([
      {
        subcontractor_id: 'sub_0001',
        company_name: 'Apex Builders',
        primary_trade: 'roofing',
        qualification_status: QUALIFICATION_STATUSES.CONTACTED,
        last_contact: '2026-08-25T10:00:00Z'
      }
    ]);
    expect(followActive).toContain('Apex Builders');
    expect(followActive).toContain('sub_0001');
  });
});

describe('subcontractor-recruiter (Core write-through)', () => {
  let fetchSpy;

  beforeEach(() => {
    fetchSpy = jest.spyOn(global, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  function mockResponse(status, body) {
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body
    };
  }

  describe('mapCoreToJS & mapJSToCore', () => {
    it('correctly maps between Core Subcontractor and JS object', () => {
      const core = {
        id: 7,
        external_id: 'sub_0007',
        company_name: 'Acme Framing',
        primary_trade: 'framing',
        w9_received: 1,
        msa_signed: 0,
        coi_received: 1,
        workers_comp: 0,
        license_required: 1,
        general_liability: 1,
        last_contact_at: '2026-08-27T12:00:00.000Z'
      };

      const js = mapCoreToJS(core);
      expect(js.subcontractor_id).toBe('sub_0007');
      expect(js.id).toBe(7);
      expect(js.w9_received).toBe(true);
      expect(js.msa_signed).toBe(false);
      expect(js.coi_received).toBe(true);
      expect(js.workers_comp).toBe(false);
      expect(js.last_contact).toBe('2026-08-27T12:00:00.000Z');

      const backToCore = mapJSToCore(js);
      expect(backToCore.external_id).toBe('sub_0007');
      expect(backToCore.id).toBe(7);
      expect(backToCore.w9_received).toBe(1);
      expect(backToCore.msa_signed).toBe(0);
      expect(backToCore.last_contact_at).toBe('2026-08-27T12:00:00.000Z');
    });
  });

  describe('loadSubcontractors', () => {
    it('fetches subcontractors from Core API', async () => {
      fetchSpy.mockResolvedValue(mockResponse(200, {
        subcontractors: [
          { id: 1, external_id: 'sub_0001', company_name: 'Elite Drywall', primary_trade: 'drywall' }
        ]
      }));

      const list = await loadSubcontractors();
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(fetchSpy.mock.calls[0][0].pathname).toBe('/api/v1/subcontractors');
      expect(list).toHaveLength(1);
      expect(list[0].subcontractor_id).toBe('sub_0001');
      expect(list[0].company_name).toBe('Elite Drywall');
    });
  });

  describe('getSubcontractorById & findSubcontractor', () => {
    it('finds subcontractor by query string', async () => {
      fetchSpy.mockResolvedValue(mockResponse(200, {
        subcontractor: { id: 2, external_id: 'sub_0002', company_name: 'Apex Plumbing', phone: '8605551234' }
      }));

      const found = await findSubcontractor('8605551234');
      expect(found.subcontractor_id).toBe('sub_0002');
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(fetchSpy.mock.calls[0][0].searchParams.get('q')).toBe('8605551234');
    });

    it('gets subcontractor by numeric id', async () => {
      fetchSpy.mockResolvedValue(mockResponse(200, {
        subcontractor: { id: 3, external_id: 'sub_0003', company_name: 'Pro Electric' }
      }));

      const found = await getSubcontractorById(3);
      expect(found.id).toBe(3);
      expect(fetchSpy.mock.calls[0][0].pathname).toBe('/api/v1/subcontractors/3');
    });
  });

  describe('createOrUpdateSubcontractorLead', () => {
    it('upserts a subcontractor lead via POST /api/v1/subcontractors/upsert', async () => {
      fetchSpy.mockResolvedValue(mockResponse(200, {
        subcontractor: {
          id: 10,
          external_id: 'sub_0010',
          company_name: 'New Contractor LLC',
          primary_trade: 'roofing',
          qualification_status: 'NEW_LEAD'
        }
      }));

      const created = await createOrUpdateSubcontractorLead({
        subcontractor_id: 'sub_0010',
        company_name: 'New Contractor LLC',
        primary_trade: 'roofing'
      });

      expect(created.subcontractor_id).toBe('sub_0010');
      expect(created.id).toBe(10);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(fetchSpy.mock.calls[0][0].pathname).toBe('/api/v1/subcontractors/upsert');
    });
  });

  describe('updateSubcontractor', () => {
    it('updates subcontractor record via Core API', async () => {
      fetchSpy
        .mockResolvedValueOnce(mockResponse(200, {
          subcontractor: { id: 5, external_id: 'sub_0005', company_name: 'Existing Sub' }
        }))
        .mockResolvedValueOnce(mockResponse(200, {
          subcontractor: { id: 5, external_id: 'sub_0005', company_name: 'Existing Sub', primary_trade: 'painting' }
        }))
        .mockResolvedValueOnce(mockResponse(200, {
          subcontractor: { id: 5, external_id: 'sub_0005', qualification_status: 'QUALIFIED_PENDING_DOCUMENTS' }
        }));

      const updated = await updateSubcontractor('sub_0005', {
        primary_trade: 'painting',
        qualification_status: 'QUALIFIED_PENDING_DOCUMENTS'
      });

      expect(updated.subcontractor_id).toBe('sub_0005');
      expect(fetchSpy.mock.calls[1][0].pathname).toBe('/api/v1/subcontractors/5/update');
      expect(fetchSpy.mock.calls[2][0].pathname).toBe('/api/v1/subcontractors/5/qualification');
    });
  });
});

