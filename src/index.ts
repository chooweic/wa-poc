// Worker entry point: HTTP routes and the queue consumer.
//
//   /webhook                 Meta WhatsApp webhook (public; verified by signature)
//   /mock-wa                 chat simulator                       (admin login)
//   /mock-app                mock HR system dashboard             (admin login)
//   /mock-api/transactions   the mock HR system's one API endpoint (admin login)
//   /evidence/:id            uploaded evidence files              (admin login)
//   /admin                   KB, technical settings, drafts...    (admin login)

import { isSameOrigin, requireAdmin } from './auth';
import { getEvidence } from './drafts-repo';
import type { Env, QueueJob } from './env';
import { getMockState, handleMockTransaction } from './mock-app/api';
import { ensureMockSeed } from './mock-app/seed';
import { processJob } from './pipeline';
import { handleAdmin } from './ui/admin';
import mockAppPage from './ui/mock-app.html';
import { handleMockWa } from './ui/mock-wa';
import { htmlResponse, json, redirect } from './util';
import { handleWebhookPost, handleWebhookVerify } from './webhook';

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';

  // The only public route. Meta proves who it is with a signature, not a password.
  if (path === '/webhook') {
    if (request.method === 'GET') return handleWebhookVerify(request, env);
    if (request.method === 'POST') return handleWebhookPost(request, env);
    return new Response('Method not allowed', { status: 405 });
  }

  // Everything else is behind the admin password.
  const denied = requireAdmin(request, env);
  if (denied) return denied;
  if (request.method === 'POST' && !isSameOrigin(request)) {
    return new Response('Cross-site request blocked', { status: 403 });
  }

  if (path === '/') return redirect('/mock-wa');
  if (path === '/mock-wa' || path.startsWith('/mock-wa/')) return handleMockWa(request, env, url);
  if (path === '/admin' || path.startsWith('/admin/')) return handleAdmin(request, env, url);

  if (path === '/mock-app' && request.method === 'GET') {
    await ensureMockSeed(env);
    return htmlResponse(mockAppPage);
  }
  if (path === '/mock-app/api/state' && request.method === 'GET') return json(await getMockState(env.DB));

  if (path === '/mock-api/transactions' && request.method === 'POST') {
    const payload = await request.json().catch(() => null);
    const key = request.headers.get('idempotency-key') ?? (payload as { reference?: string } | null)?.reference ?? null;
    const result = await handleMockTransaction(env.DB, payload, typeof key === 'string' ? key : null);
    return json(result.body, result.status);
  }

  if (path.startsWith('/evidence/') && request.method === 'GET') return serveEvidence(env, path.slice('/evidence/'.length));

  return new Response('Not found', { status: 404 });
}

/** Evidence is only ever served through this admin-protected route; the R2 bucket itself is private. */
async function serveEvidence(env: Env, id: string): Promise<Response> {
  const evidence = await getEvidence(env.DB, id);
  const object = evidence ? await env.EVIDENCE.get(evidence.r2_key) : null;
  if (!evidence || !object) return new Response('Not found', { status: 404 });
  return new Response(object.body, {
    headers: {
      'content-type': evidence.mime_type,
      'content-disposition': 'inline',
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
      // Images are locked down fully; browsers' built-in PDF viewers need to be left alone.
      ...(evidence.kind === 'image' ? { 'content-security-policy': "default-src 'none'; sandbox" } : {}),
    },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await route(request, env);
    } catch (error) {
      console.error('request failed:', (error as Error)?.message ?? error);
      return new Response('Internal error', { status: 500 });
    }
  },

  /** Queue consumer: one message at a time (see wrangler.jsonc), so a user's messages never race on their draft. */
  async queue(batch: MessageBatch<QueueJob>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      // processJob handles its own failures (it replies to the user and marks the
      // message failed), so the job is always acknowledged rather than re-run.
      await processJob(env, message.body);
      message.ack();
    }
  },
} satisfies ExportedHandler<Env, QueueJob>;
