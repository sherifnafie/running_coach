import { useEffect } from 'react';
import { Shell } from './components/Shell';
import { appStore } from './lib/appState';
import { boot } from './lib/controller';
import { useStore } from './lib/store';
import { SetupScreen, SignInScreen, UnreachableScreen } from './screens/Auth';
import { OnboardingSteps } from './screens/Onboarding';

export function App() {
  const phase = useStore(appStore, (s) => s.boot);
  const onboarding = useStore(appStore, (s) => s.onboarding);

  useEffect(() => {
    void boot();
  }, []);

  switch (phase) {
    case 'loading':
      return (
        <div className="splash" role="status" aria-label="Loading">
          <img src="/icon.svg" alt="" width="72" height="72" />
        </div>
      );
    case 'needs-setup':
      return <SetupScreen />;
    case 'signed-out':
      return <SignInScreen />;
    case 'unreachable':
      return <UnreachableScreen />;
    case 'ready':
      return onboarding ? <OnboardingSteps /> : <Shell />;
  }
}
