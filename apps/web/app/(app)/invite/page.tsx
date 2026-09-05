'use client';
/**
 * Accept a workspace invitation. Lives inside the app shell so an
 * unsigned-in visitor is bounced to /login?next=/invite?token=… and comes
 * straight back; the token is only consumed once the signed-in email
 * matches the one invited.
 */
import { Suspense, useState } from 'react';
import { api } from '@/lib/api';
import { useApp } from '@/lib/app-context';
import { useLinkToken, useRedeemOnce } from '@/lib/link-token';
import { Button, EmptyState } from '@/components/ui';
import { Icon } from '@/components/shell/icons';

type Outcome =
  | { status: 'working' }
  | { status: 'joined'; name: string; id: string }
  | { status: 'invalid_token' }
  | { status: 'wrong_account'; invitedEmail: string | null };

function Invite() {
  const token = useLinkToken('/invite');
  const { me, refreshMe, switchWorkspace, signOut } = useApp();
  const [o, setO] = useState<Outcome>({ status: 'working' });
  useRedeemOnce(
    token,
    (t) => {
      api.members
        .accept(t)
        .then(async (r) => {
          if (r.status === 'joined') {
            await refreshMe();
            switchWorkspace(r.workspace.id);
            setO({ status: 'joined', name: r.workspace.name, id: r.workspace.id });
          } else setO(r);
        })
        .catch(() => setO({ status: 'invalid_token' }));
    },
    () => setO({ status: 'invalid_token' }),
  );

  if (o.status === 'working')
    return (
      <p style={{ color: 'var(--muted)' }} aria-live="polite">
        Opening your invitation…
      </p>
    );
  if (o.status === 'joined')
    return (
      <EmptyState
        icon={<Icon.check />}
        title={`You're in ${o.name}`}
        body="Everything in it — credits, brand, library — is yours to use now."
        actions={<Button href="/studio">Open the studio</Button>}
      />
    );
  if (o.status === 'wrong_account') {
    return (
      <EmptyState
        icon={<Icon.user />}
        title="This invitation is for someone else"
        body={`It was sent to ${o.invitedEmail ?? 'a different address'}, and you are signed in as ${me.user.email ?? 'another account'}. Sign out and sign in with the invited address to accept it.`}
        actions={
          <Button variant="subtle" onClick={() => void signOut()}>
            Sign out
          </Button>
        }
      />
    );
  }
  return (
    <EmptyState
      icon={<Icon.library />}
      title="That invitation has expired"
      body="Invitations work once and for 7 days. Ask whoever sent it to invite you again."
      actions={
        <Button href="/today" variant="ghost">
          Go to Today
        </Button>
      }
    />
  );
}

export default function Page() {
  return (
    <div className="rise">
      <Suspense fallback={null}>
        <Invite />
      </Suspense>
    </div>
  );
}
