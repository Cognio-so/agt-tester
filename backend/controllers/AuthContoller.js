const bcrypt = require('bcryptjs');
const User = require('../models/User');
const { generateAccessToken, generateRefreshTokenAndSetCookie, clearRefreshTokenCookie } = require('../lib/utilis');
const passport = require('passport');
const crypto = require('crypto');
const Invitation = require('../models/Invitation');
const nodemailer = require('nodemailer');
const jwt = require('jsonwebtoken');
const UserGptAssignment = require('../models/UserGptAssignment');
const multer = require('multer');
const { uploadToR2, deleteFromR2 } = require('../lib/r2');
const mongoose = require('mongoose');
const UserFavorite = require('../models/UserFavorite');
const ChatHistory = require('../models/ChatHistory');
const { sendVerificationEmail, sendWelcomeEmail, sendResetPasswordEmail, sendPasswordResetSuccessEmail } = require('../mailtrap/email');


const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'your-secure-encryption-key-exactly-32-b'; // Make this exactly 32 bytes
const IV_LENGTH = 16; // For AES, this is always 16 bytes

// Function to encrypt API keys
function encrypt(text) {
    try {
        // Ensure key is exactly 32 bytes
        let key = Buffer.from(ENCRYPTION_KEY);
        if (key.length !== 32) {
            const newKey = Buffer.alloc(32);
            key.copy(newKey, 0, 0, Math.min(key.length, 32));
            key = newKey;
        }
        
        const iv = crypto.randomBytes(IV_LENGTH);
        const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
        let encrypted = cipher.update(text);
        encrypted = Buffer.concat([encrypted, cipher.final()]);
        return iv.toString('hex') + ':' + encrypted.toString('hex');
    } catch (err) {
        console.error("Encryption error:", err);
        throw err;
    }
}

// Function to decrypt API keys
function decrypt(text) {
    try {
        // Check if the text is in the correct format
        if (!text || !text.includes(':')) {
            return '';
        }

        let key = Buffer.from(ENCRYPTION_KEY);
        if (key.length !== 32) {
            const newKey = Buffer.alloc(32);
            key.copy(newKey, 0, 0, Math.min(key.length, 32));
            key = newKey;
        }
        
        const textParts = text.split(':');
        const iv = Buffer.from(textParts.shift(), 'hex');
        const encryptedText = Buffer.from(textParts.join(':'), 'hex');
        
        // Ensure IV is correct length
        if (iv.length !== IV_LENGTH) {
            return '';
        }

        const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
        let decrypted = decipher.update(encryptedText);
        decrypted = Buffer.concat([decrypted, decipher.final()]);
        return decrypted.toString();
    } catch (err) {
        console.error("Decryption error:", err);
        return '';
    }
}

// --- Multer setup for profile picture ---
const profilePicStorage = multer.memoryStorage();
const profilePicUpload = multer({
    storage: profilePicStorage,
    limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit for profile pics
    fileFilter: (req, file, cb) => {
        if (file.mimetype.startsWith('image/')) {
            cb(null, true);
        } else {
            cb(new Error('Not an image! Please upload an image file.'), false);
        }
    }
}).single('profileImage');

const Signup = async (req, res) => {
    const { name, email, password } = req.body;

    try {
        if (!name || !email || !password) {
            return res.status(400).json({ success: false, message: 'All fields are required' });
        }

        const userAlreadyExists = await User.findOne({ email });
        if (userAlreadyExists) {
            return res.status(400).json({ success: false, message: 'User already exists' });
        }

        if (password.length < 6) {
            return res.status(400).json({ success: false, message: 'Password must be at least 6 characters long' });
        }

        const hashedPassword = await bcrypt.hash(password, 10);
        const verificationToken = Math.floor(100000 + Math.random() * 900000).toString();

        const newUser = new User({
            name,
            email,
            password: hashedPassword,
            verificationToken,
            verificationTokenExpiresAt: Date.now() + 24 * 60 * 60 * 1000,
            profilePic: req.file ? `/uploads/profilePics/${req.file.filename}` : undefined,
        });

        await newUser.save();
        await sendVerificationEmail(email, verificationToken);

        return res.status(201).json({
            success: true,
            message: 'Signup successful. Please verify your email.',
        });
    } catch (error) {
        console.error('Signup Error:', error);
        return res.status(500).json({ success: false, message: error.message });
    }
};

const verifyEmail = async (req, res) => {
    const { code } = req.body;
    try {
        const user = await User.findOne({
            verificationToken: code,
            verificationTokenExpiresAt: { $gt: Date.now() },
        });

        if (!user) {
            return res.status(400).json({ success: false, message: 'Invalid or expired verification code' });
        }

        user.isVerified = true;
        user.verificationToken = undefined;
        user.verificationTokenExpiresAt = undefined;
        await user.save();

        await sendWelcomeEmail(user.email, user.name);

        return res.status(200).json({
            success: true,
            message: 'Email verified successfully. Welcome to the app!',
            user: {
                ...user._doc,
                password: undefined,
            },
        });
    } catch (error) {
        console.error('Error verifying email:', error);
        return res.status(500).json({
            success: false,
            message: 'Error verifying email',
            error: error.message,
        });
    }
};

const Login = async (req, res) => {
    const { email, password } = req.body;

    try {
        if (!email || !password) {
            return res.status(400).json({ success: false, message: 'Email and password are required' });
        }

        const user = await User.findOne({ email }).select('+password');
        if (!user || !user.password) {
            return res.status(400).json({ success: false, message: 'Invalid credentials' });
        }

        const isPasswordValid = await bcrypt.compare(password, user.password);
        if (!isPasswordValid) {
            return res.status(400).json({ success: false, message: 'Invalid credentials' });
        }

        const accessToken = generateAccessToken(user._id);
        const refreshToken = generateRefreshTokenAndSetCookie(res, user._id);

        user.lastActive = new Date();
        await user.save();

        return res.status(200).json({
            success: true,
            message: 'Login successful',
            accessToken,
            refreshToken,
            user: {
                _id: user._id,
                name: user.name,
                email: user.email,
                profilePic: user.profilePic,
                role: user.role,
                isVerified: user.isVerified,
            },
        });
    } catch (error) {
        console.error('Login Error:', error);
        return res.status(500).json({ success: false, message: 'Server error' });
    }
};

const googleAuth = passport.authenticate('google', { scope: ['profile', 'email'] });

const googleAuthCallback = (req, res, next) => {

    passport.authenticate('google', {
        failureRedirect: `${process.env.FRONTEND_URL || 'http://localhost:5173'}/login?error=google_auth_failed`,
        session: false
    }, async (err, user, info) => {

        if (err) {
            console.error("Google Auth Error:", err);
            return res.redirect(`${process.env.FRONTEND_URL || 'http://localhost:5173'}/login?error=google_auth_error`);
        }
        if (!user) {
            console.error("Google Auth Failed:", info?.message);
            return res.redirect(`${process.env.FRONTEND_URL || 'http://localhost:5173'}/login?error=${encodeURIComponent(info?.message || 'google_auth_failed')}`);
        }

        try {
            user.lastActive = new Date();
            await user.save();

            const accessToken = generateAccessToken(user._id);
            generateRefreshTokenAndSetCookie(res, user._id);

            // Set additional cookie for SameSite issue (optional)
            const userData = {
                _id: user._id,
                name: user.name,
                email: user.email,
                profilePic: user.profilePic,
                role: user.role
            };

            const feRedirectUrl = new URL(`${process.env.FRONTEND_URL || 'http://localhost:5173'}/auth/callback`);
            feRedirectUrl.searchParams.set('accessToken', accessToken);
            feRedirectUrl.searchParams.set('user', JSON.stringify(userData));

            return res.redirect(feRedirectUrl.toString());

        } catch (error) {
            console.error("Error during Google auth token generation/redirect:", error);
            return res.redirect(`${process.env.FRONTEND_URL || 'http://localhost:5173'}/login?error=processing_failed`);
        }
    })(req, res, next);
};
const Logout = async (req, res) => {
    clearRefreshTokenCookie(res);
    res.status(200).json({
        success: true,
        message: 'Logged out successfully'
    });
};

const forgetPassword = async (req, res) => {
    const { email } = req.body;

    try {

        const user = await User.findOne({ email });

        if (!user) {
            return res.status(400).json({ success: false, message: 'User not found' });
        }

        const resetToken = crypto.randomBytes(32).toString('hex');
        const resetTokenExpiresAt = Date.now() + 24 * 60 * 60 * 1000;

        user.resetPasswordToken = resetToken;
        user.resetPasswordExpiresAt = resetTokenExpiresAt;
        await user.save();

        const resetURL = `${process.env.FRONTEND_URL || 'http://localhost:5173'}/reset-password/${resetToken}`;
        await sendResetPasswordEmail(email, resetURL);

        return res.status(200).json({
            success: true,
            message: 'Reset password email sent successfully',
        });

    } catch (error) {
        console.error('Error during forget password:', error);
        return res.status(500).json({
            success: false,
            message: 'Server error during forget password',
            error: error.message,
        });
    }
}

const resetpassword = async (req, res) => {
    try {
        const { token } = req.params;
        const { password } = req.body;

        if (!password) {
            return res.status(400).json({
                success: false,
                message: 'Password is required'
            });
        }

        const user = await User.findOne({
            resetPasswordToken: token,
            resetPasswordExpiresAt: { $gt: Date.now() }
        });

        if (!user) {
            return res.status(400).json({ success: false, message: 'Invalid or expired reset token' });
        }

        const hashedPassword = await bcrypt.hash(password, 10);
        user.password = hashedPassword;

        user.resetPasswordToken = undefined;
        user.resetPasswordExpiresAt = undefined;
        await user.save();

        await sendPasswordResetSuccessEmail(user.email);

        return res.status(200).json({
            success: true,
            message: 'Password reset successfully',
        });

    } catch (error) {
        console.error('Error during reset password:', error);
        return res.status(500).json({
            success: false,
            message: 'Server error during reset password',
            error: error.message,
        });
    }
};

const refreshTokenController = async (req, res) => {
    const refreshToken = req.cookies.refreshToken;

    if (!refreshToken) {
        return res.status(401).json({ message: 'Refresh token not found' });
    }

    try {
        const decoded = jwt.verify(refreshToken, process.env.REFRESH_TOKEN_SECRET);

        const user = await User.findById(decoded.userId);
        if (!user) {
            return res.status(401).json({ message: 'User not found for refresh token' });
        }
        const newAccessToken = generateAccessToken(decoded.userId);

        user.lastActive = new Date();
        await user.save();

        res.status(200).json({ accessToken: newAccessToken });

    } catch (error) {
        console.error("Refresh Token Error:", error);

        clearRefreshTokenCookie(res);
        if (error.name === 'JsonWebTokenError' || error.name === 'TokenExpiredError') {
            return res.status(403).json({ message: 'Invalid or expired refresh token' });
        }
        return res.status(500).json({ message: 'Server error during token refresh' });
    }
};

const getCurrentUser = async (req, res) => {
    try {
        const userId = req.user._id;

        const user = await User.findOne({ email: req.user.email });
        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }

        user.lastActive = new Date();
        await user.save();

        res.status(200).json({
            _id: user._id,
            name: user.name,
            email: user.email,
            profilePic: user.profilePic,
            role: user.role
        });
    } catch (error) {
        console.error("Get Current User Error:", error);
        res.status(500).json({ message: 'Server error fetching user data.' });
    }
};

const getAllUsers = async (req, res) => {
    try {
        if (req.user.role !== 'admin') {
            return res.status(403).json({ message: 'Not authorized to access this resource' });
        }

        const users = await User.find({}).select('-password').sort({ createdAt: -1 });

        res.status(200).json({
            success: true,
            users
        });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};
const removeTeamMember = async (req, res) => {
    try {
        const { userId } = req.params;

        if (req.user.role !== 'admin') {
            return res.status(403).json({ success: false, message: 'Only admins can remove team members' });
        }

        const user = await User.findById(userId);
        if (!user) {
            return res.status(404).json({ success: false, message: 'User not found' });
        }

        const session = await mongoose.startSession();
        try {
            await session.withTransaction(async () => {
                const [chatResult, gptResult, favResult, userResult] = await Promise.all([
                    ChatHistory.deleteMany({ userId }).session(session),
                    UserGptAssignment.deleteMany({ userId }).session(session),
                    UserFavorite.deleteMany({ userId }).session(session),
                    User.findByIdAndDelete(userId).session(session)
                ]);

                return res.status(200).json({
                    success: true,
                    message: 'User and all associated data removed successfully',
                    deletionResults: {
                        chatHistory: chatResult,
                        gptAssignments: gptResult,
                        favorites: favResult,
                        user: !!userResult
                    }
                });
            });
        } finally {
            session.endSession();
        }
    } catch (error) {
        console.error('Error removing team member:', error);
        return res.status(500).json({
            success: false,
            message: 'Failed to remove team member',
            error: error.message
        });
    }
};

const setInactive = async (req, res) => {
    try {
        if (!req.user || !req.user._id) {
            return res.status(401).json({ message: 'Not authorized' });
        }

        const userId = req.user._id;
        await User.findByIdAndUpdate(userId, { $set: { lastActive: null } });

        res.status(200).json({ success: true, message: 'User marked as inactive.' });
    } catch (error) {
        console.error("Error setting user inactive:", error);
        res.status(500).json({ success: false, message: 'Failed to mark user as inactive.' });
    }
};

const getUsersWithGptCounts = async (req, res) => {
    try {
        if (req.user.role !== 'admin') {
            return res.status(403).json({ success: false, message: 'Not authorized' });
        }

        const page = parseInt(req.query.page, 10) || 1;
        const limit = parseInt(req.query.limit, 10) || 10;
        const skip = (page - 1) * limit;

        const [total, users, assignments] = await Promise.all([
            User.countDocuments({ _id: { $ne: req.user._id } }),
            User.find({ _id: { $ne: req.user._id } })
                .select('name email role createdAt lastActive')
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(limit)
                .lean(),
            UserGptAssignment.aggregate([
                { $group: { _id: '$userId', count: { $sum: 1 } } },
            ]),
        ]);

        const gptCountMap = Object.fromEntries(
            assignments.map(({ _id, count }) => [_id.toString(), count])
        );

        const usersWithCounts = users.map((user) => ({
            ...user,
            gptCount: gptCountMap[user._id] || 0,
        }));

        return res.status(200).json({
            success: true,
            users: usersWithCounts,
            total,
            page,
            limit,
        });
    } catch (error) {
        console.error('Error fetching users with GPT counts:', error);
        return res.status(500).json({ success: false, message: error.message });
    }
};

const getUserGptCount = async (req, res) => {
    try {
        const { userId } = req.params;

        const count = await UserGptAssignment.countDocuments({ userId });

        res.status(200).json({
            success: true,
            count
        });
    } catch (error) {
        console.error('Error fetching user GPT count:', error);
        res.status(500).json({ message: error.message });
    }
};

const getUserActivity = async (req, res) => {
    try {
        const { userId } = req.params;

        if (req.user.role !== 'admin' && req.user._id.toString() !== userId) {
            return res.status(403).json({ message: 'Not authorized to access this resource' });
        }
        return res.status(200).json({
            success: true,
            activities: []
        });
    } catch (error) {
        console.error('Error fetching user activity:', error);
        return res.status(500).json({ message: error.message });
    }
};

const updateUserProfile = async (req, res) => {
    const { name, email } = req.body;
    const userId = req.user._id;

    try {
        if (!name && !email) {
            return res.status(400).json({ success: false, message: 'Please provide name or email to update.' });
        }

        const user = await User.findById(userId);
        if (!user) {
            return res.status(404).json({ success: false, message: 'User not found.' });
        }

        if (email && email !== user.email) {
            const existingUser = await User.findOne({ email: email });
            if (existingUser) {
                return res.status(400).json({ success: false, message: 'Email address already in use.' });
            }
            user.email = email;
        }

        if (name) {
            user.name = name;
        }

        await user.save();

        const updatedUser = await User.findById(userId).select('-password');

        res.status(200).json({
            success: true,
            message: 'Profile updated successfully.',
            user: updatedUser
        });

    } catch (error) {
        console.error('Error updating user profile:', error);
        res.status(500).json({ success: false, message: 'Server error updating profile.' });
    }
};

const updateUserProfilePicture = async (req, res) => {
    const userId = req.user._id;

    try {
        const user = await User.findById(userId);
        if (!user) {
            return res.status(404).json({ success: false, message: 'User not found.' });
        }

        if (!req.file) {
            return res.status(400).json({ success: false, message: 'No image file provided.' });
        }

        if (user.profilePic) {
            try {
                if (process.env.R2_PUBLIC_URL && user.profilePic.startsWith(process.env.R2_PUBLIC_URL)) {
                    const key = user.profilePic.replace(process.env.R2_PUBLIC_URL + '/', '');
                    await deleteFromR2(key);
                }
            } catch (deleteError) {
                console.error("Failed to delete old profile picture, proceeding anyway:", deleteError);
            }
        }

        const { fileUrl } = await uploadToR2(
            req.file.buffer,
            req.file.originalname,
            `profile-pics/${userId}`
        );

        user.profilePic = fileUrl;
        await user.save();

        const updatedUser = await User.findById(userId).select('-password');

        res.status(200).json({
            success: true,
            message: 'Profile picture updated successfully.',
            user: updatedUser
        });

    } catch (error) {
        console.error('Error updating profile picture:', error);
        if (error.message.includes('Not an image')) {
            return res.status(400).json({ success: false, message: 'Invalid file type. Please upload an image.' });
        }
        res.status(500).json({ success: false, message: 'Server error updating profile picture.' });
    }
};

const changePassword = async (req, res) => {
    const { currentPassword, newPassword } = req.body;
    const userId = req.user._id;

    try {
        if (!currentPassword || !newPassword) {
            return res.status(400).json({ success: false, message: 'Please provide both current and new passwords.' });
        }
        if (newPassword.length < 6) {
            return res.status(400).json({ success: false, message: 'New password must be at least 6 characters long.' });
        }

        const user = await User.findById(userId).select('+password');
        if (!user) {
            return res.status(404).json({ success: false, message: 'User not found.' });
        }

        const isMatch = await bcrypt.compare(currentPassword, user.password);
        if (!isMatch) {
            return res.status(400).json({ success: false, message: 'Incorrect current password.' });
        }

        const salt = await bcrypt.genSalt(10);
        user.password = await bcrypt.hash(newPassword, salt);
        await user.save();

        res.status(200).json({
            success: true,
            message: 'Password updated successfully.'
        });

    } catch (error) {
        console.error('Error changing password:', error);
        res.status(500).json({ success: false, message: 'Server error changing password.' });
    }
};


const getApiKeys = async (req, res) => {
    try {
        const user = await User.findById(req.user._id).select('+apiKeys');

        if (!user) {
            return res.status(404).json({ success: false, message: 'User not found' });
        }

        if (!user.apiKeys) {
            return res.json({ success: true, apiKeys: {} });
        }

        const decryptedKeys = {};
        for (const [key, value] of Object.entries(user.apiKeys)) {
            if (value) {
                try {
                    decryptedKeys[key] = decrypt(value);
                    if (!decryptedKeys[key]) {
                        decryptedKeys[key] = '';
                    }
                } catch (error) {
                    console.error(`Failed to decrypt key ${key}:`, error);
                    decryptedKeys[key] = '';
                }
            } else {
                decryptedKeys[key] = '';
            }
        }

        return res.json({ success: true, apiKeys: decryptedKeys });
    } catch (error) {
        console.error('Error getting API keys:', error);
        return res.status(500).json({ success: false, message: 'Server error' });
    }
};

const saveApiKeys = async (req, res) => {
    try {
        const { apiKeys } = req.body;

        if (!apiKeys) {
            return res.status(400).json({ success: false, message: 'No API keys provided' });
        }


        const user = await User.findById(req.user._id).select('+apiKeys');

        if (!user) {
            return res.status(404).json({ success: false, message: 'User not found' });
        }

        const encryptedKeys = {};
        for (const [key, value] of Object.entries(apiKeys)) {
            if (value) {
                try {
                    encryptedKeys[key] = encrypt(value);
                } catch (err) {
                    console.error(`Error encrypting ${key}:`, err);
                    throw err;
                }
            }
        }

        user.apiKeys = encryptedKeys;

        await user.save();

        return res.json({ success: true, message: 'API keys saved successfully' });
    } catch (error) {
        console.error('Error saving API keys:', error);
        return res.status(500).json({ success: false, message: error.message || 'Server error' });
    }
};

const updatePassword = async (req, res) => {
    try {
        const { currentPassword, newPassword } = req.body;

        if (!currentPassword || !newPassword) {
            return res.status(400).json({ success: false, message: 'All fields are required' });
        }

        const user = await User.findById(req.user._id).select('+password');

        if (!user) {
            return res.status(404).json({ success: false, message: 'User not found' });
        }

        const isMatch = await bcrypt.compare(currentPassword, user.password);
        if (!isMatch) {
            return res.status(400).json({ success: false, message: 'Current password is incorrect' });
        }

        const salt = await bcrypt.genSalt(10);
        user.password = await bcrypt.hash(newPassword, salt);

        await user.save();

        return res.json({ success: true, message: 'Password updated successfully' });
    } catch (error) {
        console.error('Error updating password:', error);
        return res.status(500).json({ success: false, message: 'Server error' });
    }
};

const updateUserPermissions = async (req, res) => {
    try {
        const { userId } = req.params;
        const { role, department } = req.body;

        if (req.user.role !== 'admin') {
            return res.status(403).json({
                success: false,
                message: 'Only admins can update user permissions'
            });
        }

        const user = await User.findById(userId);
        if (!user) {
            return res.status(404).json({
                success: false,
                message: 'User not found'
            });
        }

        if (role) {
            user.role = role.toLowerCase();
        }

        if (department) {
            user.department = department;
        }

        await user.save();

        res.status(200).json({
            success: true,
            message: 'User permissions updated successfully',
            user: {
                id: user._id,
                name: user.name,
                email: user.email,
                role: user.role,
                department: user.department
            }
        });
    } catch (error) {
        console.error('Error updating user permissions:', error);
        res.status(500).json({
            success: false,
            message: 'Server error updating permissions.'
        });
    }
};

module.exports = {
    Signup,
    Login,
    Logout,
    googleAuth,
    googleAuthCallback,
    refreshTokenController,
    getCurrentUser,
    getAllUsers,
    setInactive,
    removeTeamMember,
    getUsersWithGptCounts,
    getUserGptCount,
    getUserActivity,
    updateUserProfile,
    updateUserProfilePicture,
    changePassword,
    getApiKeys,
    saveApiKeys,
    updatePassword,
    updateUserPermissions,
    verifyEmail,
    forgetPassword, resetpassword
};