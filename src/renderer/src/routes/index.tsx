import { Navigate } from 'react-router-dom'
import { useAppConfig } from '@renderer/hooks/use-app-config'
import { getSiderCardRoute } from '@renderer/utils/sider'
import { isWebMode } from '@renderer/utils/web'
import {
  Connections,
  DNS,
  Logs,
  Mihomo,
  NetworkPageComponent,
  Override,
  Profiles,
  Proxies,
  Resources,
  Rules,
  Settings,
  Sniffer,
  SubStore,
  Sysproxy,
  Traffic,
  Tun
} from './route-pages'

export { useDeferredRoutePreload, preloadRoute } from './route-pages'

// Web 服务模式下系统代理设置没有意义：它只会改容器所在宿主机的代理，而不是访问者的设备。
// 保留路径并重定向，避免旧书签 / 旧 siderOrder 落到空页面。
const sysproxyElement: React.ReactNode = isWebMode ? (
  <Navigate to="/network" replace />
) : (
  <Sysproxy />
)

const HomeRedirect: React.FC = () => {
  const { appConfig } = useAppConfig()

  if (!appConfig) return null
  const dest = appConfig.rememberSelectedSiderCard ? appConfig.lastSelectedSiderCard : 'proxy'
  return <Navigate to={getSiderCardRoute(dest)} replace />
}

const routes = [
  {
    path: '/network',
    element: <NetworkPageComponent />
  },
  {
    path: '/mihomo',
    element: <Mihomo />
  },
  {
    path: '/sysproxy',
    element: sysproxyElement
  },
  {
    path: '/tun',
    element: <Tun />
  },
  {
    path: '/proxies',
    element: <Proxies />
  },
  {
    path: '/rules',
    element: <Rules />
  },
  {
    path: '/resources',
    element: <Resources />
  },
  {
    path: '/dns',
    element: <DNS />
  },
  {
    path: '/sniffer',
    element: <Sniffer />
  },
  {
    path: '/logs',
    element: <Logs />
  },
  {
    path: '/connections',
    element: <Connections />
  },
  {
    path: '/override',
    element: <Override />
  },
  {
    path: '/profiles',
    element: <Profiles />
  },
  {
    path: '/settings',
    element: <Settings />
  },
  {
    path: '/substore',
    element: <SubStore />
  },
  {
    path: '/traffic',
    element: <Traffic />
  },
  {
    path: '/',
    element: <HomeRedirect />
  }
]

export default routes
