import type { Metadata, Viewport } from 'next'
import { Lora, Inter, IBM_Plex_Mono } from 'next/font/google'
import { Analytics } from '@vercel/analytics/next'
import { SessionProvider } from 'next-auth/react'
import { auth } from '@/lib/auth'
import { AmbientBackground } from '@/components/ambient-background'
import { CommandPalette, CommandPaletteHint } from '@/components/command-palette'
import { TerminalOverlay } from '@/components/terminal/terminal-overlay'
import { GrimoireFloatingPanel } from '@/components/grimoire-floating-panel'
import { GolemMascot } from '@/components/golem/golem-mascot'
import { GolemStateProvider } from '@/components/golem/golem-state-context'
import './globals.css'

const lora = Lora({
  subsets: ['latin'],
  variable: '--font-lora',
  display: 'swap',
})

const inter = Inter({
  subsets: ['latin'],
  variable: '--font-inter',
  display: 'swap',
})

const ibmPlexMono = IBM_Plex_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-ibm-plex-mono',
  display: 'swap',
})

export const metadata: Metadata = {
  title: 'Golem | Autonomous AI Operating System',
  description: 'Advanced AI superagent platform for autonomous task execution and intelligent automation',
  generator: 'v0.app',
  icons: {
    icon: [
      { url: '/favicon-32.png', sizes: '32x32', type: 'image/png' },
      { url: '/icon-192.png', sizes: '192x192', type: 'image/png' },
      { url: '/icon-512.png', sizes: '512x512', type: 'image/png' },
      { url: '/icon.svg', type: 'image/svg+xml' },
    ],
    apple: '/apple-touch-icon.png',
  },
}

export const viewport: Viewport = {
  themeColor: '#0e1012',
  width: 'device-width',
  initialScale: 1,
}

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  const session = await auth()

  return (
    <html lang="en" className={`${lora.variable} ${inter.variable} ${ibmPlexMono.variable} bg-background`}>
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `try {
              const theme = localStorage.getItem('enry-theme');
              // Graphite dark is the :root default; 'og' (old default) and 'light'
              // (old theme) both migrate forward rather than rendering stale.
              if (theme === 'midnight') document.documentElement.setAttribute('data-theme', 'midnight');
              else if (theme === 'light' || theme === 'graphite-light') document.documentElement.setAttribute('data-theme', 'graphite-light');
              else document.documentElement.removeAttribute('data-theme');
            } catch (e) {}`,
          }}
        />
      </head>
      <body className="font-sans antialiased">
        <AmbientBackground />
        <SessionProvider session={session}>
          <GolemStateProvider>
            {children}
            <CommandPalette />
            <CommandPaletteHint />
            <TerminalOverlay />
            <GrimoireFloatingPanel />
            <GolemMascot />
          </GolemStateProvider>
        </SessionProvider>
        {process.env.NODE_ENV === 'production' && <Analytics />}
      </body>
    </html>
  )
}
