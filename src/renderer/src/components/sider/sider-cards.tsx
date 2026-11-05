import { useLayoutEffect, useEffect, useRef, useState } from 'react'
import {
  DndContext,
  closestCorners,
  PointerSensor,
  useSensor,
  useSensors,
  DragEndEvent,
  Modifier,
  CollisionDetection
} from '@dnd-kit/core'
import { SortableContext } from '@dnd-kit/sortable'
import { NavigateFunction, useNavigate } from 'react-router-dom'
import SysproxySwitcher from '@renderer/components/sider/sysproxy-switcher'
import TunSwitcher from '@renderer/components/sider/tun-switcher'
import ProfileCard from '@renderer/components/sider/profile-card'
import ProxyCard from '@renderer/components/sider/proxy-card'
import RuleCard from '@renderer/components/sider/rule-card'
import DNSCard from '@renderer/components/sider/dns-card'
import SniffCard from '@renderer/components/sider/sniff-card'
import OverrideCard from '@renderer/components/sider/override-card'
import ConnCard from '@renderer/components/sider/conn-card'
import LogCard from '@renderer/components/sider/log-card'
import MihomoCoreCard from '@renderer/components/sider/mihomo-core-card'
import ResourceCard from '@renderer/components/sider/resource-card'
import SubStoreCard from '@renderer/components/sider/substore-card'
import NetworkCard from '@renderer/components/sider/network-card'
import UsageCard from '@renderer/components/sider/usage-card'
import { useAppConfig } from '@renderer/hooks/use-app-config'
import { mergeSiderOrder, SIDER_CARD_ROUTES } from '@renderer/utils/sider'
import { preloadRoute } from '@renderer/routes/route-pages'
import { markInitialContentPartReady } from '@renderer/utils/startup'
import { DEFAULT_SIDER_ORDER } from '../../../../shared/appConfig'

const componentMap: Record<SiderCardKey, React.FC<{ iconOnly?: boolean; expanded?: boolean }>> = {
  sysproxy: SysproxySwitcher,
  tun: TunSwitcher,
  profile: ProfileCard,
  proxy: ProxyCard,
  mihomo: MihomoCoreCard,
  connection: ConnCard,
  dns: DNSCard,
  sniff: SniffCard,
  log: LogCard,
  rule: RuleCard,
  resource: ResourceCard,
  override: OverrideCard,
  substore: SubStoreCard,
  network: NetworkCard,
  usage: UsageCard
}

interface Props {
  iconOnly?: boolean
  expanded?: boolean
}

const SiderCards = (props: Props): React.JSX.Element => {
  const { iconOnly = false, expanded = false } = props
  const { appConfig, patchAppConfig } = useAppConfig()
  const siderOrder = appConfig?.siderOrder ?? DEFAULT_SIDER_ORDER
  const lockSiderCards = appConfig?.lockSiderCards ?? false
  const [order, setOrder] = useState<SiderCardKey[]>(mergeSiderOrder(siderOrder))
  // 移动 6px 以上才算拖拽排序，避免手抖的点击被当成拖动（那样只会重排、不会跳转）
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }))
  const navigate: NavigateFunction = useNavigate()
  const pressStart = useRef<{ x: number; y: number } | null>(null)

  useLayoutEffect(() => {
    markInitialContentPartReady('sider')
  }, [])

  useEffect(() => {
    setOrder(mergeSiderOrder(siderOrder))
  }, [siderOrder])

  // 卡片里还有开关、刷新、编辑等按钮，点它们不该跳转
  const isInteractiveTarget = (target: EventTarget | null): boolean =>
    target instanceof HTMLElement &&
    Boolean(
      target.closest(
        'button, a, input, select, textarea, [role="switch"], [role="checkbox"], [role="slider"]'
      )
    )

  const onCardClick =
    (key: SiderCardKey) =>
    (event: React.MouseEvent<HTMLDivElement>): void => {
      const start = pressStart.current
      pressStart.current = null
      // 拖动排序后松手也会触发 click，位移超过阈值就当成拖拽
      if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 6) return
      if (isInteractiveTarget(event.target)) return
      const dest = SIDER_CARD_ROUTES[key]
      if (dest) navigate(dest)
    }

  const onDragEnd = async (event: DragEndEvent): Promise<void> => {
    const { active, over } = event
    const activeId = active.id as SiderCardKey
    if (over && !lockSiderCards) {
      if (active.id !== over.id) {
        const overId = over.id as SiderCardKey
        const newOrder = order.slice()
        const activeIndex = newOrder.indexOf(activeId)
        const overIndex = newOrder.indexOf(overId)
        if (activeIndex === -1 || overIndex === -1) return
        newOrder.splice(activeIndex, 1)
        newOrder.splice(overIndex, 0, activeId)
        setOrder(newOrder)
        await patchAppConfig({ siderOrder: newOrder })
        return
      }
    }
    const dest = SIDER_CARD_ROUTES[activeId]
    if (dest) navigate(dest)
  }

  const lockTransform: Modifier = (args) => {
    if (lockSiderCards) return { ...args.transform, x: 0, y: 0 }
    return args.transform
  }

  const collisionDetection: CollisionDetection = (args) => {
    if (lockSiderCards) return []
    return closestCorners(args)
  }

  const cards = order.map((key) => {
    const Component = componentMap[key]
    const route = SIDER_CARD_ROUTES[key]
    // display:contents 的包装层不参与布局，只用来接点击与悬停预加载
    return (
      <div
        key={key}
        className="contents"
        onPointerDown={(event) => {
          pressStart.current = { x: event.clientX, y: event.clientY }
        }}
        onClick={iconOnly ? undefined : onCardClick(key)}
        onPointerEnter={() => preloadRoute(route)}
        onFocus={() => preloadRoute(route)}
      >
        <Component iconOnly={iconOnly} expanded={expanded} />
      </div>
    )
  })

  if (iconOnly) {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto no-scrollbar">
        <div className="min-h-full w-full flex flex-col gap-2">{cards}</div>
      </div>
    )
  }

  return (
    <div style={{ overflowX: 'clip' }}>
      <DndContext
        sensors={sensors}
        collisionDetection={collisionDetection}
        onDragEnd={onDragEnd}
        modifiers={[lockTransform]}
      >
        <div className="grid grid-cols-2 gap-2 m-2">
          <SortableContext items={order}>{cards}</SortableContext>
        </div>
      </DndContext>
    </div>
  )
}

export default SiderCards
