import { describe, expect, it, vi } from 'vitest';
import { SIGNUP_PROMO_CREDITS } from '@anystudio/shared';
import { AuthService } from './auth.service';
import { RegistrationService } from './registration.service';

/**
 * Signing up as an organization is the same account with a different first
 * workspace: the organization itself, not "Ada's studio". What is pinned is
 * that the workspace is an ORGANIZATION named after it, that it still gets
 * the welcome credits through the ledger like every other workspace, that no
 * personal studio is created beside it (homeSurface() only sends a member of
 * only-organization workspaces to the portal), and that the welcome lands on
 * the organization's own page.
 */

function db() {
  const workspace = { create: vi.fn(async (args: { data: Record<string, unknown> }) => ({ ...args.data, id: 'ws-org', wallet: { id: 'wallet-1' } })) };
  const client = {
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(client),
    user: { create: vi.fn(async () => ({ id: 'user-1', email: 'ada@bimbomarket.ng' })) },
    workspace,
    authEvent: { create: vi.fn(async () => ({})) },
  };
  return client;
}

const input = {
  name: 'Ada Obi',
  email: 'ada@bimbomarket.ng',
  phone: '+2348012345678',
  country: 'NG',
  password: 'password123',
  phoneIsWhatsApp: false,
  marketing: { granted: false, wording: 'No marketing' },
};
const req = { ip: '1.1.1.1', requestId: 'r', get: () => undefined } as never;

describe('registering an organization', () => {
  it('makes the first workspace the organization, named after it, with the website kept', async () => {
    const client = db();
    const ledger = { grant: vi.fn(async () => ({})) };
    const service = new RegistrationService(client as never, ledger as never);
    const out = await service.register({ ...input, organization: { name: ' Bimbo Marketplace Ltd ', website: 'https://bimbomarket.ng' } }, req);
    expect(out).toMatchObject({ kind: 'created', workspaceId: 'ws-org' });
    expect(client.workspace.create).toHaveBeenCalledTimes(1);
    const data = client.workspace.create.mock.calls[0]![0].data as Record<string, unknown>;
    expect(data).toMatchObject({ type: 'ORGANIZATION', name: 'Bimbo Marketplace Ltd', profile: { billingCountry: 'NG', website: 'https://bimbomarket.ng' } });
  });

  it('still grants the welcome credits through the ledger, keyed on the workspace', async () => {
    const client = db();
    const ledger = { grant: vi.fn(async () => ({})) };
    await new RegistrationService(client as never, ledger as never).register({ ...input, organization: { name: 'Bimbo' } }, req);
    expect(ledger.grant).toHaveBeenCalledWith(
      expect.objectContaining({ walletId: 'wallet-1', amount: SIGNUP_PROMO_CREDITS, idempotencyKey: 'signup:ws-org' }),
      expect.anything(),
    );
  });

  it('leaves a person alone: no organization, a personal studio as before', async () => {
    const client = db();
    await new RegistrationService(client as never, { grant: vi.fn(async () => ({})) } as never).register(input, req);
    const data = client.workspace.create.mock.calls[0]![0].data as Record<string, unknown>;
    expect(data).toMatchObject({ type: 'PERSONAL', name: "Ada's studio", profile: { billingCountry: 'NG' } });
  });

  it('sends an organization to its own welcome page after sign-in', async () => {
    const finishSignIn = vi.fn(async () => ({ status: 'handoff', url: 'https://org.example/auth/handoff?token=t' }));
    const service = Object.assign(Object.create(AuthService.prototype), {
      surfaceFromOrigin: () => 'APP',
      registration: { register: vi.fn().mockResolvedValue({ kind: 'created', user: { id: 'user-1' }, workspaceId: 'ws-org' }) },
      verification: { issue: vi.fn(async () => undefined) },
      publicOrigin: () => 'https://anystudio.ai',
      finishSignIn,
    }) as AuthService;
    await service.register(
      {
        name: 'Ada',
        email: 'ada@x.ng',
        phone: '+2348012345678',
        password: 'password123',
        marketing: { granted: false, wording: 'n' },
        organization: { name: 'Bimbo' },
      },
      { get: () => undefined } as never,
      {} as never,
    );
    expect(finishSignIn).toHaveBeenCalledWith(expect.anything(), 'APP', 1, '/welcome/organization', expect.anything(), expect.anything());
    // and the organization reached the registration service
    expect((service as unknown as { registration: { register: ReturnType<typeof vi.fn> } }).registration.register).toHaveBeenCalledWith(
      expect.objectContaining({ organization: { name: 'Bimbo' } }),
      expect.anything(),
    );
  });
});
