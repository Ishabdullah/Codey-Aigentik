import { jest } from '@jest/globals';
import { customerDetailBlock } from '../index.js';

// Regression for the "phone number shown as the customer's name" bug:
// appt.attendee_name is a snapshot taken at proposal time and can hold the
// senderLabel phone-number fallback (an SMS from an unknown Google Voice
// number supplies no sender_name). The linked contact record is the source
// of truth and must win.
describe('customerDetailBlock — name resolution', () => {
  let fetchSpy;
  beforeEach(() => { fetchSpy = jest.spyOn(global, 'fetch'); });
  afterEach(() => { fetchSpy.mockRestore(); });

  const mockContact = (contact) => fetchSpy.mockResolvedValue({
    ok: true, status: 200, json: async () => ({ contact }),
  });

  it('uses the linked contact name over a phone-number attendee_name', async () => {
    mockContact({
      id: 409, external_id: 'contact_0409', name: 'Jake',
      phones: ['8609822868'], emails: ['jake@example.com'], address: '345 Chestnut St',
    });
    const appt = { contact_id: 'contact_0409', attendee_name: '8609822868', attendee_email: null };
    const block = await customerDetailBlock(appt, '8609822868', null);
    expect(block).toContain('👤 Name: Jake');
    expect(block).not.toContain('👤 Name: 8609822868');
  });

  it('falls back to attendee_name, then the label, when the contact has no name', async () => {
    mockContact({ id: 410, external_id: 'contact_0410', name: null, phones: ['8609822868'], emails: [], address: null });
    const withApptName = await customerDetailBlock(
      { contact_id: 'contact_0410', attendee_name: 'Jake R.', attendee_email: null }, 'label-fallback', null,
    );
    expect(withApptName).toContain('👤 Name: Jake R.');

    mockContact({ id: 410, external_id: 'contact_0410', name: null, phones: [], emails: [], address: null });
    const withLabel = await customerDetailBlock(
      { contact_id: 'contact_0410', attendee_name: null, attendee_email: null }, 'label-fallback', null,
    );
    expect(withLabel).toContain('👤 Name: label-fallback');
  });
});
