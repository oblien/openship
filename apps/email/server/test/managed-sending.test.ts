import { expect, test, spyOn } from 'bun:test';
import { configureSending, sendingSettings } from '../src/mail/sending-settings';
import { deliverMailboxMessage, needsMime } from '../src/lib/outbound';
import { sendingAdminRoute } from '../src/routes/sending-admin';
import * as imap from '../src/lib/imap';
import * as smtp from '../src/lib/smtp';
import { env } from '../src/env';
import { appSendingSettings } from '../src/mail/sending-credentials';

test('a standalone app sends with its OpenShip key from Apps settings', async () => {
  const previous = { host: env.DEFAULT_IMAP_HOST, settings: env.managedSending };
  const host = 'mail.apps.example';
  const key = 'opsh_pat_app_fixture';
  const mailbox = { host, user: 'alice@apps.example', pass: 'test', port: env.DEFAULT_IMAP_PORT };
  const message = { from: mailbox.user, to: ['bob@example.org'], text: 'Hello', subject: 'Hi' };
  expect(() => appSendingSettings(key)).toThrow('pinned IMAP');
  expect(() => appSendingSettings('opsh_unknown', 'legacy', host)).toThrow('valid OpenShip');
  expect(appSendingSettings('omk_fixture', 'legacy', host)).toEqual({ key: 'omk_fixture', namespace: 'legacy' });
  const auth = spyOn(imap, 'withImap').mockResolvedValue(undefined);
  const native = spyOn(smtp, 'sendMail').mockRejectedValue(new Error('Unexpected SMTP'));
  const api = spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ id: 'test', state: 'queued' }, { status: 202 }));
  try {
    env.DEFAULT_IMAP_HOST = host;
    env.managedSending = appSendingSettings(key, undefined, host);
    await expect(deliverMailboxMessage(mailbox, { ...mailbox, host: 'foreign.example' }, message))
      .rejects.toThrow('authenticated mailbox');
    await deliverMailboxMessage(mailbox, mailbox, message);
    expect(auth).toHaveBeenCalledTimes(1);
    expect(api).toHaveBeenCalledTimes(1);
    const [[url, request]] = api.mock.calls;
    expect(String(url)).toBe('https://api.openship.io/api/mail/send');
    expect(new Headers(request?.headers).get('authorization')).toBe('Bearer ' + key);
    await expect(deliverMailboxMessage(mailbox, mailbox, { ...message, inReplyTo: '<id@apps.example>' }))
      .rejects.toThrow('full MIME');
    expect(native).not.toHaveBeenCalled();
  } finally {
    env.DEFAULT_IMAP_HOST = previous.host;
    env.managedSending = previous.settings;
    auth.mockRestore();
    native.mockRestore();
    api.mockRestore();
  }
});

test('webmail keeps threads, custom headers and attachments on the MIME path', () => {
  const message = {
    from: 'alice@example.com',
    to: ['bob@example.org'],
    subject: 'Hi',
    html: 'Hello',
  };
  expect(needsMime(message)).toBe(false);
  expect(needsMime({ ...message, subject: 'x'.repeat(999) })).toBe(true);
  expect(needsMime({ ...message, to: [], bcc: ['bob@example.net'] })).toBe(false);
  expect(needsMime({ ...message, cc: [], bcc: ['bob@example.net'] })).toBe(false);
  expect(needsMime({ ...message, inReplyTo: '<id@example.com>' })).toBe(true);
  expect(needsMime({ ...message, attachments: [{ filename: 'notes', content: 'notes' }] })).toBe(
    true,
  );
  expect(needsMime({ ...message, references: ['<id@example.com>'] })).toBe(true);
});

test('only the private sending token installs keys, scoped to the selected sender domain', async () => {
  const original = [env.DEFAULT_IMAP_HOST, env.sendingAdminToken];
  const domain = 'managed.example';
  try {
    env.DEFAULT_IMAP_HOST = 'mail.managed.example';
    env.sendingAdminToken = 'test-sending-admin';
    const url = '/sending/' + domain;
    const key = {
      keyId: 'key-1',
      namespace: 'openship-mail-' + '1'.repeat(32),
      key: 'send-only-test',
    };
    const send = (token: string) =>
      sendingAdminRoute.request(url, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', 'x-openship-sending-token': token },
        body: JSON.stringify(key),
      });
    expect((await send('wrong')).status).toBe(401);
    expect((await send(env.sendingAdminToken)).status).toBe(200);
    expect(sendingSettings(domain)).toEqual({ namespace: key.namespace, key: key.key });
    expect(sendingSettings('another.example')).toBeFalsy();
    const read = await sendingAdminRoute.request(url, {
      headers: { 'x-openship-sending-token': env.sendingAdminToken },
    });
    expect(await read.json()).toEqual({ sending: { namespace: key.namespace, keyId: key.keyId } });
    configureSending(domain, key.namespace, 'rotated', 'key-2');
    expect(sendingSettings(domain)?.key).toBe('rotated');
  } finally {
    [env.DEFAULT_IMAP_HOST, env.sendingAdminToken] = original;
  }
});

test('authenticated mailbox dispatch uses the SDK and a stable retry key even after a lost receipt', async () => {
  const host = env.DEFAULT_IMAP_HOST;
  env.DEFAULT_IMAP_HOST = 'mail.sdk.example';
  const mailbox = {
    host: env.DEFAULT_IMAP_HOST,
    user: 'test@sdk.example',
    pass: 'test',
    port: env.DEFAULT_IMAP_PORT,
  };
  const namespace = 'openship-mail-' + 'a'.repeat(32);
  configureSending('sdk.example', namespace, 'scoped-send-test', 'key-sdk');
  const auth = spyOn(imap, 'withImap').mockResolvedValue(undefined);
  const native = spyOn(smtp, 'sendMail').mockRejectedValue(new Error('Unexpected SMTP dispatch'));
  const api = spyOn(globalThis, 'fetch')
    .mockRejectedValueOnce(new Error('Connection lost'))
    .mockResolvedValueOnce(
      Response.json({ success: true, data: { state: 'queued', id: 'receipt' } }, { status: 202 }),
    );
  const input = {
    from: mailbox.user,
    to: ['bob@example.org'],
    bcc: ['archive@example.org'],
    messageId: '<outbox-job@sdk.example>',
    cc: [],
    html: '',
    subject: 'New mail',
    text: 'Hello',
  };
  try {
    await expect(
      deliverMailboxMessage(mailbox, mailbox, { ...input, from: 'other@sdk.example' }),
    ).rejects.toThrow('authenticated mailbox');
    expect(api).not.toHaveBeenCalled();
    await expect(deliverMailboxMessage(mailbox, mailbox, input)).rejects.toThrow('Connection lost');
    expect(await deliverMailboxMessage(mailbox, mailbox, input)).toEqual({
      messageId: input.messageId,
    });
    expect(auth).toHaveBeenCalledTimes(2);
    expect(api).toHaveBeenCalledTimes(2);
    const [[url, first], [, second]] = api.mock.calls;
    expect(String(url)).toContain('/mail/' + namespace + '/messages');
    const headers = new Headers(first?.headers);
    expect(headers.get('authorization')).toBe('Bearer scoped-send-test');
    expect(headers.get('idempotency-key')).toMatch(/^[0-9a-f]{64}$/);
    expect(new Headers(second?.headers).get('idempotency-key')).toBe(
      headers.get('idempotency-key'),
    );
    expect(JSON.parse(String(first?.body))).toEqual({
      from: mailbox.user,
      to: input.to,
      bcc: input.bcc,
      subject: input.subject,
      text: input.text,
    });
    expect(native).not.toHaveBeenCalled();
  } finally {
    env.DEFAULT_IMAP_HOST = host;
    auth.mockRestore();
    native.mockRestore();
    api.mockRestore();
  }
});

test('a hosted webmail accepts one organization and requires a verified key even for full MIME', async () => {
  const host = env.DEFAULT_IMAP_HOST,
    token = env.sendingAdminToken;
  env.DEFAULT_IMAP_HOST = 'mail.slot.example';
  env.sendingAdminToken = 'private-hosting-token';
  const namespace = 'openship-mail-' + 'b'.repeat(32);
  const bind = (tenant: string, imapHost: string) =>
    sendingAdminRoute.request('/hosting', {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        'x-openship-sending-token': env.sendingAdminToken!,
      },
      body: JSON.stringify({ namespace: tenant, imapHost, dedicated: true }),
    });
  const native = spyOn(smtp, 'sendMail').mockRejectedValue(new Error('Unexpected SMTP dispatch'));
  const auth = spyOn(imap, 'withImap').mockResolvedValue(undefined);
  const api = spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ id: 'receipt', state: 'queued' }, { status: 202 }));
  try {
    expect((await bind(namespace, 'other.example')).status).toBe(409);
    expect(await (await bind(namespace, env.DEFAULT_IMAP_HOST)).json()).toEqual({ bound: true });
    expect(await (await bind(namespace, env.DEFAULT_IMAP_HOST)).json()).toEqual({ bound: true });
    expect(
      await (await bind('openship-mail-' + 'c'.repeat(32), env.DEFAULT_IMAP_HOST)).json(),
    ).toEqual({ bound: false });
    const url = '/sending/api.hosted.test';
    const credential = { keyId: 'pat_hosted', key: 'opsh_pat_fixture', apiOrigin: 'https://cloud.example' };
    const headers = { 'x-openship-sending-token': env.sendingAdminToken, 'content-type': 'application/json' };
    const put = (tenant: string) => sendingAdminRoute.request(url, {
      method: 'PUT', headers, body: JSON.stringify({ ...credential, namespace: tenant }),
    });
    expect((await put('openship-mail-' + 'c'.repeat(32))).status).toBe(409);
    for (const key of [credential.key, 'opsh_send_fixture']) {
      const providerRequest = await sendingAdminRoute.request(url, {
        method: 'PUT', headers, body: JSON.stringify({ key, keyId: credential.keyId, namespace }),
      });
      expect(providerRequest.status).toBe(400);
    }
    expect((await put(namespace)).status).toBe(200);
    expect(await (await sendingAdminRoute.request(url, { headers })).json()).toEqual({
      sending: { apiOrigin: credential.apiOrigin, keyId: credential.keyId, namespace },
    });
    expect(sendingSettings('api.hosted.test')).toEqual({ apiOrigin: credential.apiOrigin, namespace, key: credential.key });
    const mailbox = {
      host: env.DEFAULT_IMAP_HOST,
      port: env.DEFAULT_IMAP_PORT,
      user: 'person@unconfigured.test',
      pass: 'test',
    };
    await expect(
      deliverMailboxMessage(mailbox, mailbox, {
        from: mailbox.user,
        to: ['somebody@example.com'],
        subject: 'Test',
        text: 'test',
        inReplyTo: '<test@example.com>',
      }),
    ).rejects.toThrow('Verify and enable managed sending');
    const hostedMailbox = { ...mailbox, user: 'user@api.hosted.test' };
    await deliverMailboxMessage(hostedMailbox, hostedMailbox, {
      from: hostedMailbox.user, to: ['recipient@example.org'], subject: 'Hello', text: 'Hello',
    });
    const [[endpoint, init]] = api.mock.calls;
    expect(String(endpoint)).toBe(credential.apiOrigin + '/api/mail/send');
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer ' + credential.key);
    await expect(deliverMailboxMessage(hostedMailbox, hostedMailbox, {
      from: hostedMailbox.user, to: ['somebody@example.com'], subject: 'Notes', text: 'attached',
      attachments: [{ filename: 'notes.txt', content: 'notes' }],
    })).rejects.toThrow('full MIME');
    const legacy = await sendingAdminRoute.request(url, {
      method: 'PUT', headers, body: JSON.stringify({ namespace, key: 'legacy-fixture', keyId: 'legacy' }),
    });
    expect(legacy.status).toBe(200);
    await expect(deliverMailboxMessage(hostedMailbox, hostedMailbox, {
      from: hostedMailbox.user, to: ['somebody@example.com'], subject: 'Re: Notes', text: 'reply',
      inReplyTo: '<previous@example.com>',
    })).rejects.toThrow('full MIME');
    expect(native).not.toHaveBeenCalled();
  } finally {
    const { db, schema } = await import('../src/db');
    const { eq, inArray } = await import('drizzle-orm');
    db.delete(schema.mailInstance)
      .where(inArray(schema.mailInstance.id, ['hosted-sending-namespace', 'dedicated-mail-namespace']))
      .run();
    db.delete(schema.sendingDomain).where(eq(schema.sendingDomain.domain, 'api.hosted.test')).run();
    auth.mockRestore();
    api.mockRestore();
    env.DEFAULT_IMAP_HOST = host;
    env.sendingAdminToken = token;
    native.mockRestore();
  }
});

test.each(['OpenShip API', 'legacy provider'] as const)('shared webmail selects the authenticated domain key for each organization with %s', async transport => {
  const { db, schema } = await import('../src/db');
  const { eq } = await import('drizzle-orm');
  const { bindHostedSending, sharedHosting } = await import('../src/mail/sending-settings');
  const previous = env.DEFAULT_IMAP_HOST;
  env.DEFAULT_IMAP_HOST = 'mail.shared.test';
  const namespaces = ['a', 'b'].map(c => 'openship-mail-' + c.repeat(32));
  const domains = ['first.shared.test', 'second.shared.test'];
  const auth = spyOn(imap, 'withImap').mockResolvedValue(undefined);
  const apiOrigin = 'https://cloud.example';
  const receipt = { id: 'test-receipt', state: 'queued' };
  const useApi = transport === 'OpenShip API';
  const provider = spyOn(globalThis, 'fetch').mockImplementation(async () =>
    Response.json(useApi ? receipt : { success: true, data: receipt }, { status: 202 }));
  try {
    expect(bindHostedSending(sharedHosting)).toBe(true);
    for (const [i, domain] of domains.entries()) {
      const issuer = useApi ? JSON.stringify({ apiOrigin, namespace: namespaces[i] }) : namespaces[i]!;
      configureSending(domain, issuer, 'test-key-' + i, String(i));
      const mailbox = { host: env.DEFAULT_IMAP_HOST, port: env.DEFAULT_IMAP_PORT, user: 'me@' + domain, pass: 'test' };
      const input = { from: mailbox.user, to: ['recipient@example.org'], subject: 'Hello', text: 'Hello' };
      await deliverMailboxMessage(mailbox, mailbox, input);
      await expect(deliverMailboxMessage(mailbox, mailbox, { ...input, from: 'me@' + domains[1 - i] }))
        .rejects.toThrow('authenticated mailbox');
    }
    expect(provider.mock.calls).toHaveLength(2);
    for (const [i, [url, init]] of provider.mock.calls.entries()) {
      if (useApi) expect(String(url)).toBe(apiOrigin + '/api/mail/send');
      else expect(String(url)).toContain('/mail/' + namespaces[i] + '/messages');
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer test-key-' + i);
    }
  } finally {
    auth.mockRestore();
    provider.mockRestore();
    db.delete(schema.mailInstance).where(eq(schema.mailInstance.id, 'hosted-sending-namespace')).run();
    for (const domain of domains) db.delete(schema.sendingDomain).where(eq(schema.sendingDomain.domain, domain)).run();
    env.DEFAULT_IMAP_HOST = previous;
  }
});

test('a linked server submits with its OpenShip domain key and preserves the retry identity', async () => {
  const previous = [env.DEFAULT_IMAP_HOST, env.sendingAdminToken];
  env.DEFAULT_IMAP_HOST = 'mail.linked.example';
  env.sendingAdminToken = 'private-config-token';
  const headers = { 'x-openship-sending-token': env.sendingAdminToken, 'content-type': 'application/json' };
  const url = '/sending/linked.example';
  const credentials = { keyId: 'pat_1', key: 'opsh_send_fixture', apiOrigin: 'https://cloud.example' };
  const install = (apiOrigin: string) => sendingAdminRoute.request(url, {
    method: 'PUT', headers, body: JSON.stringify({ ...credentials, apiOrigin }),
  });
  const mailbox = { host: env.DEFAULT_IMAP_HOST, port: env.DEFAULT_IMAP_PORT, user: 'me@linked.example', pass: 'fixture' };
  const input = { from: mailbox.user, to: ['you@example.org'], subject: 'Hello', text: 'Message', messageId: '<outbox@linked.example>' };
  const auth = spyOn(imap, 'withImap').mockResolvedValue(undefined);
  const native = spyOn(smtp, 'sendMail').mockRejectedValue(new Error('Unexpected SMTP dispatch'));
  const api = spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(new Response(null, { status: 429 }))
    .mockResolvedValueOnce(Response.json({ id: 'receipt', state: 'queued' }, { status: 202 }));
  try {
    for (const origin of ['not a URL', 'http://cloud.example', 'https://name@cloud.example', 'https://cloud.example/path']) {
      expect((await install(origin)).status).toBe(400);
    }
    expect((await install(credentials.apiOrigin)).status).toBe(200);
    expect(await (await sendingAdminRoute.request(url, { headers })).json()).toEqual({
      sending: { apiOrigin: credentials.apiOrigin, keyId: credentials.keyId },
    });
    await expect(deliverMailboxMessage(mailbox, mailbox, { ...input, from: 'other@linked.example' })).rejects.toThrow('authenticated mailbox');
    expect(api).not.toHaveBeenCalled();
    await expect(deliverMailboxMessage(mailbox, mailbox, input)).rejects.toThrow('429');
    expect(await deliverMailboxMessage(mailbox, mailbox, input)).toEqual({ messageId: input.messageId });
    const [[endpoint, first], [, retry]] = api.mock.calls;
    expect(String(endpoint)).toBe('https://cloud.example/api/mail/send');
    expect(new Headers(first?.headers).get('authorization')).toBe('Bearer ' + credentials.key);
    expect(first?.body).toBe(retry?.body);
    expect(JSON.parse(String(first?.body))).toEqual({ from: mailbox.user, to: input.to, subject: input.subject, text: input.text, idempotencyKey: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(auth).toHaveBeenCalledTimes(2);
    expect(native).not.toHaveBeenCalled();
  } finally {
    [env.DEFAULT_IMAP_HOST, env.sendingAdminToken] = previous;
    auth.mockRestore(); native.mockRestore(); api.mockRestore();
  }
});
