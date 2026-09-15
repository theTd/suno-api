import type { Metadata } from 'next';
import PreviewDeck from './PreviewDeck';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Suno Preview 试听台',
  description:
    'WebSocket 实时发现可 preview 的音轨：串流捕获中 / 待捕获 / 已缓存完整，点击即渐进试听。'
};

export default function PreviewPage() {
  return <PreviewDeck />;
}
