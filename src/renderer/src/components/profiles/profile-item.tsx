import {
  Button,
  Card,
  Dropdown,
  DropdownItem,
  DropdownMenu,
  DropdownTrigger,
  Modal,
  ModalBody,
  ModalContent,
  ModalHeader,
  Tooltip
} from '@heroui/react'
import { IoMdMore, IoMdRefresh } from 'react-icons/io'
import dayjs from '@renderer/utils/dayjs'
import React, { Key, useMemo, useState } from 'react'
import { useSWRConfig } from 'swr'
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import {
  exportLocalConfig,
  getLocalConfig,
  openFile,
  removeLocalSource,
  saveLocalDraft,
  updatePluginProfile
} from '@renderer/utils/ipc'
import { parse, stringify } from 'yaml'
import { toast } from '@renderer/components/base/toast'
import { useProfileConfig } from '@renderer/hooks/use-profile-config'
import { useTranslation } from 'react-i18next'
import BaseConfirmModal from '../base/base-confirm-modal'
import LocalNodes from '../local/local-nodes'
import { isLocalProfile } from '../../../../shared/local-config'
import EditTunnelsModal from './edit-tunnels-modal'
import EditInfoModal from './edit-info-modal'
import EditFileModal from './edit-file-modal'
import QrCodeModal from './qr-code-modal'
import ProfileCardContent from './profile-card-content'

interface Props {
  info: IProfileItem
  isCurrent: boolean
  isSource?: boolean
  addProfileItem: (item: Partial<IProfileItem>) => Promise<void>
  updateProfileItem: (item: IProfileItem) => Promise<void>
  removeProfileItem: (id: string) => Promise<void>
  mutateProfileConfig: () => void
  onPress?: () => Promise<void>
}

interface MenuItem {
  key: string
  label: string
  showDivider: boolean
  color: 'default' | 'danger'
  className: string
}
const ProfileItem: React.FC<Props> = (props) => {
  const { t } = useTranslation()
  const { mutate } = useSWRConfig()
  const { changeCurrentProfile } = useProfileConfig()
  const {
    info,
    isSource = false,
    addProfileItem,
    removeProfileItem,
    mutateProfileConfig,
    updateProfileItem,
    onPress,
    isCurrent
  } = props
  const [updating, setUpdating] = useState(false)
  const [openInfoEditor, setOpenInfoEditor] = useState(false)
  const [openFileEditor, setOpenFileEditor] = useState(false)
  const [openTunnelsEditor, setOpenTunnelsEditor] = useState(false)
  const [openQrCode, setOpenQrCode] = useState(false)
  const [openLocalNodes, setOpenLocalNodes] = useState(false)
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const [dropdownOpen, setDropdownOpen] = useState(false)
  const {
    attributes,
    listeners,
    setNodeRef,
    transform: tf,
    transition,
    isDragging
  } = useSortable({
    id: info.id
  })
  const transform = tf ? { x: tf.x, y: tf.y, scaleX: 1, scaleY: 1 } : null
  const [isActuallyDragging, setIsActuallyDragging] = useState(false)
  const [clickStartPos, setClickStartPos] = useState<{ x: number; y: number } | null>(null)

  const menuItems: MenuItem[] = useMemo(() => {
    const list = [
      {
        key: 'edit-info',
        label: t('profiles.editInfo.title'),
        showDivider: false,
        color: 'default',
        className: ''
      } as MenuItem,
      {
        key: 'edit-file',
        label: t('profiles.editFile.title'),
        showDivider: false,
        color: 'default',
        className: ''
      } as MenuItem,
      {
        key: 'edit-tunnels',
        label: t('profiles.editTunnels.title'),
        showDivider: false,
        color: 'default',
        className: ''
      } as MenuItem,
      {
        key: 'open-file',
        label: t('profiles.openFile'),
        showDivider: true,
        color: 'default',
        className: ''
      } as MenuItem,
      {
        key: 'delete',
        label: t('common.delete'),
        showDivider: false,
        color: 'danger',
        className: 'text-danger'
      } as MenuItem
    ]
    if (info.type === 'remote' && info.url) {
      list.unshift({
        key: 'show-qrcode',
        label: t('profiles.qrCode.show'),
        showDivider: false,
        color: 'default',
        className: ''
      } as MenuItem)
    }
    if (info.customHome || info.home) {
      list.unshift({
        key: 'home',
        label: t('profiles.home'),
        showDivider: false,
        color: 'default',
        className: ''
      } as MenuItem)
    }
    if (isLocalProfile(info)) {
      list.splice(
        3,
        0,
        {
          key: 'local-nodes',
          label: t('profiles.localNodes'),
          showDivider: false,
          color: 'default',
          className: ''
        },
        {
          key: 'local-export',
          label: t('profiles.exportLocal'),
          showDivider: true,
          color: 'default',
          className: ''
        }
      )
    }
    if (isSource) {
      list.push({
        key: 'unlink-local-source',
        label: t('profiles.unlinkLocalSource'),
        showDivider: false,
        color: 'default',
        className: ''
      })
    }
    return isSource ? list.filter((item) => item.key !== 'edit-tunnels') : list
  }, [info, t, isSource])

  const onMenuAction = async (key: Key): Promise<void> => {
    switch (key) {
      case 'edit-info': {
        setOpenInfoEditor(true)
        break
      }
      case 'edit-file': {
        setOpenFileEditor(true)
        break
      }
      case 'edit-tunnels': {
        setOpenTunnelsEditor(true)
        break
      }
      case 'open-file': {
        openFile('profile', info.id)
        break
      }
      case 'delete': {
        setShowDeleteConfirm(true)
        break
      }

      case 'show-qrcode': {
        setOpenQrCode(true)
        break
      }
      case 'home': {
        open(info.customHome || info.home)
        break
      }
      case 'local-nodes': {
        if (!isCurrent) await changeCurrentProfile(info.id)
        setOpenLocalNodes(true)
        break
      }
      case 'local-export': {
        if (!isCurrent) await changeCurrentProfile(info.id)
        try {
          const result = await exportLocalConfig()
          if (result.path) toast.success(result.path)
          else if (result.errors.length) toast.error(result.errors.join('\n'))
        } catch (error) {
          toast.error(String(error))
        }
        break
      }
      case 'unlink-local-source': {
        try {
          const state = await getLocalConfig()
          const source = state.draft.sources.find((candidate) => candidate.profileId === info.id)
          if (source) await removeLocalSource(source.id)
          // removeLocalSource 只删 sources 链接，且源提交后可能已转成模块条目
          // （sources 为空）；这里按名称/URL 前缀把残留的 provider / 节点一并清理，
          // 否则卡片会一直被判定为"源"而无法恢复切换
          const next = await getLocalConfig()
          const sourceName = source?.name ?? info.name
          const providers = parse(next.draft.modules['proxy-providers'])
          const providersTouched = (() => {
            if (!providers || typeof providers !== 'object' || Array.isArray(providers)) {
              return false
            }
            let removed = false
            for (const [name, value] of Object.entries(providers)) {
              const sameName = name === sourceName
              const sameUrl = Boolean(info.url) && (value as { url?: unknown })?.url === info.url
              if (sameName || sameUrl) {
                delete providers[name]
                removed = true
              }
            }
            if (removed) {
              next.draft.modules['proxy-providers'] = stringify(providers)
            }
            return removed
          })()
          const prefix = `[${sourceName}] `
          const proxies = parse(next.draft.modules.proxies)
          const proxiesTouched = (() => {
            if (!Array.isArray(proxies)) return false
            const filtered = proxies.filter(
              (node) =>
                !(
                  node &&
                  typeof node === 'object' &&
                  typeof (node as { name?: unknown }).name === 'string' &&
                  ((node as { name: string }).name === prefix ||
                    (node as { name: string }).name.startsWith(prefix))
                )
            )
            if (filtered.length === proxies.length) return false
            next.draft.modules.proxies = stringify(filtered)
            return true
          })()
          if (providersTouched || proxiesTouched) {
            await saveLocalDraft(next.draft)
          }
          toast.success(t('profiles.localSourceUnlinked'))
        } catch (error) {
          toast.error(String(error))
          break
        }
        await mutate('getLocalConfig')
        mutateProfileConfig()
        break
      }
    }
  }

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setDropdownOpen(true)
  }

  const handleMouseDown = (e: React.MouseEvent) => {
    if (e.button === 0) {
      setClickStartPos({ x: e.clientX, y: e.clientY })
      setIsActuallyDragging(false)
    }
  }

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!clickStartPos) return

    const dx = e.clientX - clickStartPos.x
    const dy = e.clientY - clickStartPos.y
    if (dx * dx + dy * dy > 25) {
      setIsActuallyDragging(true)
    }
  }

  const handleMouseUp = (e: React.MouseEvent) => {
    const cleanup = () => {
      setClickStartPos(null)
      setTimeout(() => setIsActuallyDragging(false), 100)
    }

    // 只处理左键点击
    if (e.button !== 0) return cleanup()

    // 检查功能按钮点击
    const target = e.target as Element
    if (target?.closest('button, [role="menu"], [role="menuitem"], [data-slot="trigger"]')) {
      return cleanup()
    }

    // 处理卡片选中
    if (!isActuallyDragging && !isDragging && clickStartPos) {
      onPress?.()
    }

    cleanup()
  }

  return (
    <div
      className="grid col-span-1"
      style={{
        position: 'relative',
        transform: CSS.Transform.toString(transform),
        transition,
        zIndex: isDragging ? 'calc(infinity)' : undefined
      }}
    >
      {openFileEditor && <EditFileModal id={info.id} onClose={() => setOpenFileEditor(false)} />}
      {openLocalNodes && (
        <Modal
          size="3xl"
          scrollBehavior="inside"
          isOpen
          onOpenChange={() => setOpenLocalNodes(false)}
        >
          <ModalContent>
            <ModalHeader>{t('profiles.localNodes')}</ModalHeader>
            <ModalBody>
              <LocalNodes />
            </ModalBody>
          </ModalContent>
        </Modal>
      )}
      {!isSource && openTunnelsEditor && (
        <EditTunnelsModal id={info.id} onClose={() => setOpenTunnelsEditor(false)} />
      )}
      {openQrCode && info.url && (
        <QrCodeModal title={info.name} url={info.url} onClose={() => setOpenQrCode(false)} />
      )}
      {openInfoEditor && (
        <EditInfoModal
          item={info}
          onClose={() => setOpenInfoEditor(false)}
          updateProfileItem={updateProfileItem}
        />
      )}
      {showDeleteConfirm && (
        <BaseConfirmModal
          isOpen={showDeleteConfirm}
          title={t('profiles.deleteConfirm.title')}
          content={t('profiles.deleteConfirm.content', { name: info.name })}
          onCancel={() => setShowDeleteConfirm(false)}
          onConfirm={async () => {
            await removeProfileItem(info.id)
            mutateProfileConfig()
            setShowDeleteConfirm(false)
          }}
        />
      )}

      <Card
        as="div"
        fullWidth
        isPressable={false}
        onContextMenu={handleContextMenu}
        className={`${isCurrent ? 'bg-primary' : ''} ${onPress ? 'cursor-pointer' : 'cursor-default'} transition-colors duration-150`}
      >
        <div
          ref={setNodeRef}
          {...attributes}
          {...listeners}
          className="w-full h-full"
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
        >
          <ProfileCardContent
            info={info}
            isCurrent={isCurrent}
            isSource={isSource}
            actions={
              <div className="flex">
                {(info.type === 'remote' || info.pluginId) && (
                  <Tooltip placement="left" content={dayjs(info.updated).fromNow()}>
                    <Button
                      isIconOnly
                      size="sm"
                      variant="light"
                      color="default"
                      disabled={updating}
                      onPress={async () => {
                        try {
                          setUpdating(true)
                          if (info.type === 'remote') await addProfileItem(info)
                          else if (info.pluginId) await updatePluginProfile(info.pluginId, true)
                        } finally {
                          setUpdating(false)
                        }
                      }}
                    >
                      <IoMdRefresh
                        color="default"
                        className={`${isCurrent ? 'text-primary-foreground' : 'text-foreground'} text-[24px] ${updating ? 'animate-spin' : ''}`}
                      />
                    </Button>
                  </Tooltip>
                )}

                <Dropdown isOpen={dropdownOpen} onOpenChange={setDropdownOpen}>
                  <DropdownTrigger>
                    <Button isIconOnly size="sm" variant="light" color="default">
                      <IoMdMore
                        color="default"
                        className={`text-[24px] ${isCurrent ? 'text-primary-foreground' : 'text-foreground'}`}
                      />
                    </Button>
                  </DropdownTrigger>
                  <DropdownMenu onAction={onMenuAction}>
                    {menuItems.map((item) => (
                      <DropdownItem
                        showDivider={item.showDivider}
                        key={item.key}
                        color={item.color}
                        className={item.className}
                      >
                        {item.label}
                      </DropdownItem>
                    ))}
                  </DropdownMenu>
                </Dropdown>
              </div>
            }
          />
        </div>
      </Card>
    </div>
  )
}

export default ProfileItem
