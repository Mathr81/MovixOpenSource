export interface Profile {
  id: string;
  name: string;
  avatar: string;
  createdAt: string;
  isDefault?: boolean;
  ageRestriction?: number; // 0 = no restriction, 7, 12, 16, 18
}

export interface ProfileContextType {
  currentProfile: Profile | null;
  profiles: Profile[];
  selectProfile: (profileId: string) => Promise<boolean>;
  createProfile: (name: string, avatar: string, ageRestriction?: number) => Promise<void>;
  updateProfile: (profileId: string, updates: Partial<Profile>) => Promise<void>;
  deleteProfile: (profileId: string) => Promise<void>;
  isLoading: boolean;
}
