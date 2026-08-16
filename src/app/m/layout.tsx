import type { Metadata, Viewport } from 'next'
import { auth } from '@/lib/auth'
import { redirect } from 'next/navigation'
import { MobileNav } from '@/components/mobile/MobileNav'

export const metadata: Metadata = {
  title: 'Shard',
  description: 'Mobile companion for Golem — alerts and quick actions on the go.',
  manifest: '/manifest.json',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'black-translucent',
    title: 'Shard',
  },
}

export const viewport: Viewport = {
  themeColor: '#080808',
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  viewportFit: 'cover',
}

export default async function MobileLayout({ children }: { children: React.ReactNode }) {
  const session = await auth()
  if (!session?.user) redirect('/login')

  return (
    <>
      {/* Main scrollable area — bottom padding for tab bar + safe area */}
      <main
        className="min-h-dvh bg-background pb-[calc(56px+env(safe-area-inset-bottom,0px))]"
        style={{ paddingTop: 'env(safe-area-inset-top, 0px)' }}
      >
        {children}
      </main>
      <MobileNav />
    </>
  )
}
