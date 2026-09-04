'use client';
import { PageHeader } from '@/components/shell/Page';
import { EmptyState, Button } from '@/components/ui';
import { Icon } from '@/components/shell/icons';

export default function Page() {
  return (
    <div className="rise">
      <PageHeader title="Studio" lede="One product photo in. Everything you post, out." />
      <EmptyState icon={<Icon.studio />} title="The studio opens in the next release" body="Upload, place, caption and export from one screen. Until then, Today shows your credits and history." actions={<Button href="/studio" variant="ghost">Open the studio</Button>} />
    </div>
  );
}
