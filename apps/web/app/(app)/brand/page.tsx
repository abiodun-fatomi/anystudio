'use client';
import { PageHeader } from '@/components/shell/Page';
import { EmptyState, Button } from '@/components/ui';
import { Icon } from '@/components/shell/icons';

export default function Page() {
  return (
    <div className="rise">
      <PageHeader title="Brand" lede="Your name, colours, fonts and tone — applied to everything automatically." />
      <EmptyState icon={<Icon.brand />} title="No brand kit yet" body="Add a logo, a palette and a tone of voice and every image and caption picks them up." actions={<Button href="/studio" variant="ghost">Open the studio</Button>} />
    </div>
  );
}
