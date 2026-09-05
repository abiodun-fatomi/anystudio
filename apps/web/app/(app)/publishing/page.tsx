'use client';
import { PageHeader } from '@/components/shell/Page';
import { EmptyState, Button } from '@/components/ui';
import { Icon } from '@/components/shell/icons';

export default function Page() {
  return (
    <div className="rise">
      <PageHeader title="Publishing" lede="Post to Instagram and TikTok, or share to WhatsApp Status with the caption ready." />
      <EmptyState
        icon={<Icon.publish />}
        title="Nothing connected"
        body="Connect an account and every finished post can go out from here."
        actions={
          <Button href="/studio" variant="ghost">
            Open the studio
          </Button>
        }
      />
    </div>
  );
}
