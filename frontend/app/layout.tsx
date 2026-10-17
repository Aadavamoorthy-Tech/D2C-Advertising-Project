import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'AdPilot | D2C Intelligence',
  description: 'Campaign performance and data summaries for D2C teams.',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
