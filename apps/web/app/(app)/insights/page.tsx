'use client';
import { PageHeader } from '@/components/shell/Page';
import { EmptyState, Button } from '@/components/ui';
import { Icon } from '@/components/shell/icons';

export default function Page() {
  return (
    <div className="rise">
      <PageHeader title="Insights" lede="What you made, what it cost, and what worked." />
      <EmptyState icon={<Icon.insights />} title="Insights arrive with your first generations" body="Charts need a few data points. Make something first." actions={<Button href="/studio" variant="ghost">Open the studio</Button>} />
    </div>
  );
}
