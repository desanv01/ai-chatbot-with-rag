import 'server-only';
import { getUserInfo } from '@/lib/server/supabase';
import { redirect } from 'next/navigation';

// Import components
import ProfileHeader from './components/ProfileHeader';
import PersonalInfoCard from './components/PersonalInfoCard';
import ReactionGame from './components/ReactionGame';
import { AnimatedSection } from './components/ProfilePageWrapper';

const userAttributes = {
  location: '',
  joinDate: '',
  bio: '',
  position: '',
  company: '',
  education: '',
  socialLinks: {
    github: '',
    linkedin: '',
    website: ''
  }
};

export default async function ProtectedPage() {
  const userInfo = await getUserInfo();
  if (!userInfo) {
    redirect('/');
  }

  const profileUser = {
    full_name: userInfo.full_name ?? '',
    email: userInfo.email ?? ''
  };

  return (
    <div className="min-h-screen py-6 bg-gradient-to-br from-background via-background to-primary/5">
      <div className="container mx-auto px-4">
        {/* Profile Header */}
        <AnimatedSection delay={0}>
          <ProfileHeader
            userInfo={profileUser}
            userAttributes={userAttributes}
          />
        </AnimatedSection>

        {/* Main Content */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <AnimatedSection delay={0.1} direction="left">
            <PersonalInfoCard
              userInfo={profileUser}
              userAttributes={userAttributes}
            />
          </AnimatedSection>
          <AnimatedSection delay={0.3} direction="left">
            <ReactionGame />
          </AnimatedSection>
        </div>
      </div>
    </div>
  );
}
