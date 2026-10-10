import { Icon } from '../common/ui';
import { SectionPage } from '../shell/SectionPage';

/** Placeholder: one page per ComfyUI workflow will live under /generate/<workflow>. */
export default function GenerateApp() {
  return (
    <SectionPage title="Generate" drawerTitle="Workflows" nav={<p class="muted small drawer-note">No workflows yet.</p>}>
      <div class="empty">
        <Icon name="sparkle" size={40} />
        <p>Image and video generation with your ComfyUI workflows is coming here.</p>
      </div>
    </SectionPage>
  );
}
