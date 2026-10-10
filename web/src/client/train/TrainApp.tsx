import { Icon } from '../common/ui';
import { SectionPage } from '../shell/SectionPage';

/** Placeholder: datasets and LoRA training runs will live under /train. */
export default function TrainApp() {
  return (
    <SectionPage title="Train" drawerTitle="Training" nav={<p class="muted small drawer-note">No training runs yet.</p>}>
      <div class="empty">
        <Icon name="flask" size={40} />
        <p>LoRA training (datasets, runs and samples) is coming here.</p>
      </div>
    </SectionPage>
  );
}
