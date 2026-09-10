import * as llama from '../llama.js';
import config from '../config.json' with { type: 'json' };

const { buildEmailSignature } = llama;

// Pure-function tests for the contact-fields extension of buildEmailSignature.
// No LLM, no I/O — the function takes everything as arguments.
describe('buildEmailSignature contact fields', () => {
  const base = ['Aigentik', 'Restoricon LLC', 'Ish', 'Tagline here'];

  it('renders all three fields when present (text + html)', () => {
    const { text, html } = buildEmailSignature(...base, {
      phone: '860-555-0100',
      email: 'support@restoricon.com',
      license: 'HIC.1234567'
    });
    expect(text).toContain('Phone: 860-555-0100');
    expect(text).toContain('support@restoricon.com');
    expect(text).toContain('CT Lic. #HIC.1234567');
    expect(html).toContain('Phone: 860-555-0100');
    expect(html).toContain('support@restoricon.com');
    expect(html).toContain('CT Lic. #HIC.1234567');
  });

  it('adds nothing when contact is an empty object', () => {
    const { text, html } = buildEmailSignature(...base, {});
    expect(text).not.toMatch(/Phone:/);
    expect(text).not.toMatch(/CT Lic\./);
    expect(html).not.toMatch(/Phone:/);
    expect(html).not.toMatch(/CT Lic\./);
  });

  it('defaults to no contact lines when the 5th arg is omitted', () => {
    const { text, html } = buildEmailSignature(...base);
    expect(text).not.toMatch(/Phone:/);
    expect(html).not.toMatch(/Phone:/);
  });

  it('phone only', () => {
    const { text, html } = buildEmailSignature(...base, { phone: '860-555-0100' });
    expect(text).toContain('Phone: 860-555-0100');
    expect(text).not.toMatch(/CT Lic\./);
    expect(html).toContain('Phone: 860-555-0100');
  });

  it('email only', () => {
    const { text, html } = buildEmailSignature(...base, { email: 'a@b.com' });
    expect(text).toContain('a@b.com');
    expect(text).not.toMatch(/Phone:/);
    expect(html).toContain('a@b.com');
  });

  it('license only', () => {
    const { text, html } = buildEmailSignature(...base, { license: 'HIC.9' });
    expect(text).toContain('CT Lic. #HIC.9');
    expect(text).not.toMatch(/Phone:/);
    expect(html).toContain('CT Lic. #HIC.9');
  });

  it('treats null, empty string and whitespace-only as absent', () => {
    for (const v of [null, '', '   ']) {
      const { text, html } = buildEmailSignature(...base, { phone: v, email: v, license: v });
      expect(text).not.toMatch(/Phone:/);
      expect(text).not.toMatch(/CT Lic\./);
      expect(html).not.toMatch(/Phone:/);
      expect(html).not.toMatch(/CT Lic\./);
    }
  });

  it('collapses CR/LF in contact values so they cannot inject extra signature lines', () => {
    const { text, html } = buildEmailSignature(...base, {
      phone: '860-555-0100\nFake: injected line',
      email: 'a@b.com\r\nAnother: line',
      license: 'HIC.9'
    });
    expect(text).not.toMatch(/\nFake:/);
    expect(text).not.toMatch(/\nAnother:/);
    expect(text).toContain('Phone: 860-555-0100 Fake: injected line');
    expect(html).not.toContain('\n');
  });

  it('escapes HTML-significant chars in the HTML branch only, not the text branch', () => {
    const dirty = 'A & B <script>';
    const { text, html } = buildEmailSignature(...base, { phone: dirty, email: dirty, license: dirty });
    // text branch: raw, unescaped
    expect(text).toContain('A & B <script>');
    expect(text).not.toContain('&amp;');
    // html branch: escaped
    expect(html).toContain('A &amp; B &lt;script&gt;');
    expect(html).not.toContain('A & B <script>');
  });
});

describe('businessContactFromConfig', () => {
  const saved = {
    phone: config.business_phone,
    email: config.business_email,
    license: config.license_number
  };
  afterEach(() => {
    config.business_phone = saved.phone;
    config.business_email = saved.email;
    config.license_number = saved.license;
  });

  it('maps the three config keys onto the contact shape', () => {
    config.business_phone = '860-555-0100';
    config.business_email = 'support@restoricon.com';
    config.license_number = 'HIC.0600000';
    expect(llama.businessContactFromConfig()).toEqual({
      phone: '860-555-0100',
      email: 'support@restoricon.com',
      license: 'HIC.0600000'
    });
  });
});
