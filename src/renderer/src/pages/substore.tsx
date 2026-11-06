import { Button } from '@heroui/react'
import BasePage from '@renderer/components/base/base-page'
import { useAppConfig } from '@renderer/hooks/use-app-config'
import {
  ensureSubStoreServices,
  subStoreFrontendPort,
  subStorePort,
  startSubStoreFrontendServer,
  startSubStoreBackendServer,
  stopSubStoreFrontendServer,
  stopSubStoreBackendServer,
  downloadSubStore
} from '@renderer/utils/ipc'
import React, { useEffect, useState } from 'react'
import { isWebMode } from '@renderer/utils/web'
import { HiExternalLink } from 'react-icons/hi'
import { useTranslation } from 'react-i18next'
import { IoMdCloudDownload } from 'react-icons/io'

const SubStore: React.FC = () => {
  const { t } = useTranslation()
  const { appConfig } = useAppConfig()
  const { useCustomSubStore, customSubStoreUrl } = appConfig || {}
  const [backendPort, setBackendPort] = useState<number | undefined>()
  const [frontendPort, setFrontendPort] = useState<number | undefined>()
  const [isUpdating, setIsUpdating] = useState(false)
  // 浏览器里 Sub-Store 的前后端都由 Web 服务同源代理（/substore、/substore/api），
  // 直接写 127.0.0.1 只会指向用户自己的机器。桌面版仍然直连本机端口。
  const webOrigin = isWebMode ? window.location.origin : ''
  const frontendUrl = useCustomSubStore
    ? ''
    : webOrigin
      ? `${webOrigin}/substore/`
      : `http://127.0.0.1:${frontendPort}`
  const apiUrl = useCustomSubStore
    ? customSubStoreUrl
    : webOrigin
      ? `${webOrigin}/substore`
      : `http://127.0.0.1:${backendPort}`
  // 自定义 Sub-Store 只替换后端地址，前端仍用本地这份
  const embedUrl = `${frontendUrl}?api=${encodeURIComponent(apiUrl ?? '')}`
  const getPort = async (ensureStarted = true): Promise<void> => {
    if (ensureStarted) {
      const ports = await ensureSubStoreServices()
      setBackendPort(ports.backendPort)
      setFrontendPort(ports.frontendPort)
      return
    }
    setBackendPort(await subStorePort())
    setFrontendPort(await subStoreFrontendPort())
  }
  useEffect(() => {
    void getPort().catch((error) => {
      new Notification(`${t('substore.updateFailed')}: ${error}`)
    })
  }, [t, useCustomSubStore])

  if (!useCustomSubStore && !backendPort) return null
  if (!frontendPort) return null
  return (
    <>
      <BasePage
        title={t('substore.title')}
        header={
          <div className="flex gap-2">
            <Button
              title={t('substore.checkUpdate')}
              isIconOnly
              size="sm"
              className="app-nodrag"
              variant="light"
              isLoading={isUpdating}
              onPress={async () => {
                try {
                  new Notification(t('substore.updating'))
                  setIsUpdating(true)
                  await downloadSubStore()
                  await stopSubStoreBackendServer()
                  await startSubStoreBackendServer()
                  await new Promise((resolve) => setTimeout(resolve, 1000))
                  setFrontendPort(0)
                  await stopSubStoreFrontendServer()
                  await startSubStoreFrontendServer()
                  await getPort(false)
                  new Notification(t('substore.updateCompleted'))
                } catch (e) {
                  new Notification(`${t('substore.updateFailed')}: ${e}`)
                } finally {
                  setIsUpdating(false)
                }
              }}
            >
              <IoMdCloudDownload className="text-lg" />
            </Button>

            <Button
              title={t('substore.openInBrowser')}
              isIconOnly
              size="sm"
              className="app-nodrag"
              variant="light"
              onPress={() => {
                open(embedUrl)
              }}
            >
              <HiExternalLink className="text-lg" />
            </Button>
          </div>
        }
      >
        <iframe className="w-full h-full" allow="clipboard-write; clipboard-read" src={embedUrl} />
      </BasePage>
    </>
  )
}

export default SubStore
