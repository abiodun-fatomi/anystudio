'use client';
import { PageHeader } from '@/components/shell/Page';
import { EmptyState, Button } from '@/components/ui';
import { Icon } from '@/components/shell/icons';

export default function Page() {
  return (
    <div className="rise">
      <PageHeader title="Library" lede="Everything you have made, searchable and re-editable." />
      <EmptyState icon={<Icon.library />} title="Nothing here yet" body="Your first generation will appear here, with every size it was exported in." actions={<Button href="/studio" variant="ghost">Open the studio</Button>} />
    </div>
  );
}
