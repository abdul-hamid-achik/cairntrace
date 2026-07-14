import { inject } from '@vercel/analytics'
import DefaultTheme from 'vitepress/theme-without-fonts'
import './custom.css'

export default {
  extends: DefaultTheme,
  enhanceApp() {
    if (!import.meta.env.SSR) {
      inject({ framework: 'vitepress' })
    }
  },
}
