'use client';
import { PageHeader } from '@/components/shell/Page';
import { EmptyState, Button } from '@/components/ui';
import { Icon } from '@/components/shell/icons';

export default function Page() {
  return (
    <div className="rise">
      <PageHeader title="Settings" lede="Your profile, security, workspace and notifications." />
      <EmptyState icon={<Icon.settings />} title="Settings arrive in the next release" body="Profile, sessions, two-factor and the danger zone are on their way." actions={<Button href="/studio" variant="ghost">Open the studio</Button>} />
    </div>
  );
}
