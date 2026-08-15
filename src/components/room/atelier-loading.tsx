'use client'

import { motion } from 'framer-motion'
import { Loader2 } from 'lucide-react'

/**
 * Loading screen — shown while the 3D scene assets are loading.
 * Polished, branded, matches Golem's dark aesthetic.
 */
export function LoadingScreen() {
  return (
    <div className="absolute inset-0 z-20 flex flex-col items-center justify-center bg-surface-base">
      {/* Ambient glow */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            'radial-gradient(ellipse at center, rgba(58,158,96,0.04) 0%, transparent 70%)',
        }}
      />

      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4 }}
        className="relative z-10 flex flex-col items-center gap-4"
      >
        {/* Logo */}
        <div className="font-display text-xl font-bold tracking-tight text-foreground">
          Golem{' '}<span className="text-primary">HQ</span>
        </div>

        {/* Loading indicator */}
        <div className="flex items-center gap-2">
          <Loader2 className="h-4 w-4 animate-spin text-primary" />
          <span className="font-mono text-[11px] text-muted-foreground">
            Loading The Atelier…
          </span>
        </div>

        {/* Progress dots */}
        <div className="flex items-center gap-1.5">
          {[0, 0.2, 0.4].map((delay) => (
            <motion.div
              key={delay}
              className="h-1.5 w-1.5 rounded-full bg-primary"
              animate={{ opacity: [0.3, 1, 0.3], scale: [1, 1.3, 1] }}
              transition={{ duration: 1.2, repeat: Infinity, delay }}
            />
          ))}
        </div>
      </motion.div>
    </div>
  )
}
