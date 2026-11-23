import * as assert from 'node:assert/strict';
import { accountText, apiUrlProblem, creditsText, summary, uriName } from '../../src/text';

describe('text', () => {
  it('counts credits', () => {
    assert.equal(creditsText(1), '1 credit');
    assert.equal(creditsText(1234), '1,234 credits');
    assert.equal(creditsText(null), 'an unknown number of credits');
  });

  it('describes the account', () => {
    assert.equal(
      accountText({
        plan: 'pro',
        credits: 1500,
        allowance: null,
        renewsAt: '2026-12-01T00:00:00.000Z',
        maxFileBytes: 1,
      }),
      'Pro plan: 1,500 credits left, renewing on 2026-12-01.',
    );
    assert.equal(
      accountText({
        plan: 'free',
        credits: 8,
        allowance: { used: 5, limit: 13, per: 'day' },
        renewsAt: null,
        maxFileBytes: 1,
      }),
      'Free plan: 8 credits left, 5 of 13 daily credits used.',
    );
  });

  it('sends the key only over https, or plain http to this computer', () => {
    assert.equal(apiUrlProblem('https://converter.studio/api'), null);
    assert.equal(apiUrlProblem('http://localhost:8080/api'), null);
    assert.equal(apiUrlProblem('http://127.0.0.1:8080/api'), null);
    assert.match(apiUrlProblem('http://example.com/api') ?? '', /https/);
    assert.match(apiUrlProblem('https://user:pw@example.com/api') ?? '', /user name/);
    assert.match(apiUrlProblem('converter.studio') ?? '', /not a web address/);
  });

  it('sums up a batch', () => {
    const one = summary([
      {
        status: 'converted',
        source: 'file:///w/a%20b.heic',
        result: 'file:///w/a%20b.jpg',
        credits: 1,
      },
    ]);
    assert.equal(one.message, 'Converted a b.heic to a b.jpg (1 credit).');
    const many = summary([
      { status: 'converted', source: 'file:///w/1.png', result: 'file:///w/1.webp', credits: 1 },
      { status: 'converted', source: 'file:///w/2.png', result: 'file:///w/2.webp', credits: 1 },
      { status: 'failed', source: 'file:///w/3.png', code: 'conversionFailed', message: 'x' },
      { status: 'skipped', source: 'file:///w/4.mp3', code: 'unsupportedTarget', message: 'y' },
    ]);
    assert.equal(
      many.message,
      'Converted 2 files (2 credits). 1 file not converted. 1 file skipped.',
    );
    assert.equal(many.credits, 2);
    assert.equal(uriName('file:///w/x.png?query#frag'), 'x.png');
  });
});
