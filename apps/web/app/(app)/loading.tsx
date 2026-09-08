import { SectionLoading } from '@/components/ui/Display';

/** Route-code loading stays inside the shell instead of leaving the previous section frozen. */
export default function Loading() {
  return <SectionLoading />;
}
