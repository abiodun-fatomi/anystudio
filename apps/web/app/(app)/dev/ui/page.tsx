'use client';
/**
 * The component gallery. Every primitive in every state, in both themes —
 * the page a change to the design system is judged on. Development only:
 * production answers 404 (see the route's layout guard).
 */
import { useState } from 'react';
import { PageHeader, Section } from '@/components/shell/Page';
import {
  Avatar, Badge, Button, Card, CardHeader, Checkbox, Combobox, ConfirmDialog, Dialog, EmptyState, Input, MenuItem, MenuSeparator,
  Pagination, Popover, Progress, Radio, SegmentedControl, Select, Skeleton, Slider, Stat, Switch, Table, tableCell, Tabs, Textarea, Tooltip, useToast,
} from '@/components/ui';
import { Icon } from '@/components/shell/icons';

const grid: React.CSSProperties = { display: 'grid', gap: 'var(--s-4)', gridTemplateColumns: 'repeat(auto-fit,minmax(260px,1fr))', alignItems: 'start' };
const row: React.CSSProperties = { display: 'flex', gap: 'var(--s-2)', flexWrap: 'wrap', alignItems: 'center' };

export default function GalleryPage() {
  const { toast } = useToast();
  const [tab, setTab] = useState('images');
  const [seg, setSeg] = useState<'9:16' | '1:1' | '16:9'>('9:16');
  const [slider, setSlider] = useState(8);
  const [dialog, setDialog] = useState(false);
  const [sheet, setSheet] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [combo, setCombo] = useState('afrobeats');
  const [text, setText] = useState('');

  return (
    <div className="rise">
      <PageHeader title="Components" lede="Every primitive, every state. Toggle the theme from the avatar menu and it must all still read." />

      <Section title="Buttons">
        <div style={row}>
          <Button>Primary</Button><Button variant="ghost">Ghost</Button><Button variant="subtle">Subtle</Button><Button variant="danger">Danger</Button><Button variant="link">Link</Button>
          <Button loading>Saving</Button><Button disabled>Disabled</Button><Button size="sm">Small</Button><Button size="lg">Large</Button>
          <Button icon aria-label="Add" variant="ghost"><Icon.plus /></Button><Button leading={<Icon.studio />}>With icon</Button><Button href="/today" variant="ghost">As link</Button>
        </div>
      </Section>

      <Section title="Fields">
        <div style={grid}>
          <Input label="Business name" placeholder="Bimbo Fabrics" hint="Shown on every image." />
          <Input label="Price" placeholder="₦12,000" leading={<Icon.credits width={16} height={16} />} error="Enter a price like ₦12,000." defaultValue="twelve" />
          <Input label="Disabled" disabled value="Not now" readOnly />
          <Select label="Language" options={[{ value: 'en', label: 'English' }, { value: 'yo', label: 'Yoruba' }, { value: 'pcm', label: 'Pidgin' }]} defaultValue="en" />
          <Textarea label="Describe the scene" optional showCount maxLength={200} value={text} onChange={(e) => setText(e.target.value)} placeholder="On a marble counter, morning light" />
          <Combobox label="Genre" options={[{ value: 'afrobeats', label: 'Afrobeats', sub: 'African' }, { value: 'amapiano', label: 'Amapiano', sub: 'African' }, { value: 'house', label: 'House', sub: 'Dance' }, { value: 'gospel', label: 'Gospel' }]} value={combo} onChange={setCombo} />
        </div>
        <div style={{ ...grid, marginTop: 'var(--s-4)' }}>
          <div><Checkbox label="Show the price" hint="On every export size" defaultChecked /><Checkbox label="Watermark" /><Checkbox label="Disabled" disabled /></div>
          <div role="radiogroup" aria-label="Vocal"><Radio name="v" label="Female vocal" defaultChecked /><Radio name="v" label="Male vocal" /><Radio name="v" label="Instrumental" /></div>
          <div><Switch label="Auto-post to Instagram" defaultChecked /><Switch label="Email me when it is done" /></div>
          <Slider label="Duration" value={slider} min={5} max={30} step={1} onChange={setSlider} format={(v) => `${v}s`} ticks={['5s', '30s']} />
        </div>
      </Section>

      <Section title="Tabs and segments">
        <Tabs label="Studio tools" value={tab} onChange={setTab} items={[{ id: 'images', label: 'Images' }, { id: 'copy', label: 'Copy' }, { id: 'video', label: 'Video' }, { id: 'music', label: 'Music', disabled: true }]}>
          <p style={{ color: 'var(--muted)' }}>Panel for <strong>{tab}</strong>. Arrow keys move between tabs.</p>
        </Tabs>
        <div style={{ ...row, marginTop: 'var(--s-4)' }}>
          <SegmentedControl label="Aspect" value={seg} onChange={setSeg} items={[{ id: '9:16', label: '9:16' }, { id: '1:1', label: '1:1' }, { id: '16:9', label: '16:9' }]} />
        </div>
      </Section>

      <Section title="Overlays">
        <div style={row}>
          <Button variant="ghost" onClick={() => setDialog(true)}>Dialog</Button>
          <Button variant="ghost" onClick={() => setSheet(true)}>Sheet</Button>
          <Button variant="danger" onClick={() => setConfirm(true)}>Confirm</Button>
          <Popover menu trigger={<Button variant="ghost" trailing={<Icon.chevron width={16} height={16} />}>Menu</Button>}>
            {(close) => (<><MenuItem onSelect={close} leading={<Icon.user />}>Profile</MenuItem><MenuItem onSelect={close}>Settings</MenuItem><MenuSeparator /><MenuItem danger onSelect={close}>Delete</MenuItem></>)}
          </Popover>
          <Tooltip label="Tooltips explain icons; they never replace a label"><Button icon variant="ghost" aria-label="Help"><Icon.bell /></Button></Tooltip>
          <Button variant="ghost" onClick={() => toast({ title: 'Saved', body: 'Your brand kit is on every new image.', tone: 'ok' })}>Toast</Button>
          <Button variant="ghost" onClick={() => toast({ title: 'That did not work', body: 'Your credits are back. Try again in a moment.', tone: 'danger', action: { label: 'Retry', onClick: () => undefined } })}>Error toast</Button>
        </div>
        <Dialog open={dialog} onClose={() => setDialog(false)} title="Rename this workspace" description="The name appears on your images when you choose to show it." footer={<><Button variant="ghost" onClick={() => setDialog(false)}>Cancel</Button><Button onClick={() => setDialog(false)}>Save</Button></>}>
          <Input label="Name" defaultValue="Bimbo Fabrics" />
        </Dialog>
        <Dialog open={sheet} onClose={() => setSheet(false)} sheet="right" title="Generation details" description="Inputs, outputs, provider, and the credits it moved.">
          <Stat label="Credits" value="10" sub="held at request, kept on success" />
        </Dialog>
        <ConfirmDialog open={confirm} onClose={() => setConfirm(false)} onConfirm={() => setConfirm(false)} danger confirmLabel="Delete workspace" title="Delete this workspace?" description="Everything in it is removed after 30 days. Your ledger is kept for audit." />
      </Section>

      <Section title="Display">
        <div style={row}>
          <Badge>Default</Badge><Badge tone="accent">Accent</Badge><Badge tone="ok" dot>Succeeded</Badge><Badge tone="warn" dot>Queued</Badge><Badge tone="danger" dot>Failed</Badge><Badge tone="cyan">Beta</Badge><Badge mono>video.reel</Badge>
          <Avatar name="Bimbo Fabrics" size="sm" /><Avatar name="Fatomi Abiodun" /><Avatar name="A" size="lg" square />
        </div>
        <div style={{ ...grid, marginTop: 'var(--s-4)' }}>
          <Card><CardHeader title="A card" sub="With a header and an action" action={<Button size="sm" variant="ghost">Edit</Button>} /><p style={{ color: 'var(--muted)', fontSize: 'var(--t-2)' }}>Cards hold one idea. Padding comes from the scale.</p></Card>
          <Card interactive onClick={() => toast({ title: 'Card clicked' })}><CardHeader title="Interactive card" sub="Hover lifts it; focus rings it; Enter is not wired — wrap in a button for that." /></Card>
          <Card><Stat label="Generations" value="1,284" sub="last 30 days" /></Card>
          <Card><Progress label="Placing it in the scene" value={62} /><div style={{ height: 'var(--s-3)' }} /><Progress label="Waiting for a slot" value={null} detail="queued" /></Card>
          <Card><Skeleton text /><div style={{ height: 8 }} /><Skeleton text style={{ width: '70%' }} /><div style={{ height: 8 }} /><Skeleton height={120} /></Card>
        </div>
        <div style={{ marginTop: 'var(--s-4)' }}>
          <EmptyState icon={<Icon.library />} title="Nothing here yet" body="Empty states say what will be here and how to get it there." actions={<><Button>Make something</Button><Button variant="ghost">Learn more</Button></>} />
        </div>
        <div style={{ marginTop: 'var(--s-4)' }}>
          <Table>
            <thead><tr><th>When</th><th>What</th><th className={tableCell.num}>Credits</th><th className={tableCell.num}>Balance</th></tr></thead>
            <tbody>
              <tr><td className={tableCell.shrink}>4 Sep, 14:02</td><td><Badge>Generation</Badge> Branded product image</td><td className={tableCell.num}>-10</td><td className={tableCell.num}>140</td></tr>
              <tr><td className={tableCell.shrink}>4 Sep, 14:03</td><td><Badge tone="ok">Refund</Badge> Provider timed out</td><td className={tableCell.num} style={{ color: 'var(--ok)' }}>+10</td><td className={tableCell.num}>150</td></tr>
            </tbody>
          </Table>
          <Pagination><span>2 rows</span><Button variant="ghost" size="sm">Show older</Button></Pagination>
        </div>
      </Section>
    </div>
  );
}
